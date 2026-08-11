import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(body: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const supplied = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export type Route = { kind: 'reconcile'; repositoryId: number; owner: string; repo: string; prs: number[]; force?: boolean } | { kind: 'ignore'; reason: string };
const controllerCheckPrefix = 'merge-manager/shadow/pr-';
const prActions = new Set(['opened', 'reopened', 'synchronize', 'edited', 'ready_for_review', 'converted_to_draft', 'closed']);
const reviewActions = new Set(['submitted', 'edited', 'dismissed']);
export function routeEvent(event: string, payload: Record<string, any>, controllerAppId: number): Route {
  const repo = payload.repository;
  if (!repo?.id || !repo?.owner?.login || !repo?.name) return { kind: 'ignore', reason: 'missing_repository' };
  let prs: number[] = [];
  if (event === 'pull_request' && prActions.has(payload.action)) prs = [payload.number];
  else if (event === 'pull_request_review' && reviewActions.has(payload.action)) prs = [payload.pull_request?.number];
  else if (event === 'check_run') {
    const own = payload.check_run?.app?.id === controllerAppId && payload.check_run?.name?.startsWith(controllerCheckPrefix);
    if (own && payload.action !== 'rerequested') return { kind: 'ignore', reason: 'controller_check_recursion' };
    if (own && payload.action === 'rerequested') {
      prs = (payload.check_run?.pull_requests ?? []).map((p: any) => p.number);
      const route = prs.filter(Number.isInteger);
      return route.length ? { kind: 'reconcile', repositoryId: repo.id, owner: repo.owner.login, repo: repo.name, prs: route, force: true } : { kind: 'ignore', reason: 'irrelevant_event' };
    }
    if (!own && payload.action === 'completed') prs = (payload.check_run?.pull_requests ?? []).map((p: any) => p.number);
  }
  prs = prs.filter(Number.isInteger);
  return prs.length ? { kind: 'reconcile', repositoryId: repo.id, owner: repo.owner.login, repo: repo.name, prs } : { kind: 'ignore', reason: 'irrelevant_event' };
}
