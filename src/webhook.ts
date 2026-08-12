import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(body: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const supplied = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export type MergeCommand = 'ready' | 'land' | 'cancel' | 'retry';
export type Route =
  | { kind: 'reconcile'; repositoryId: number; owner: string; repo: string; prs: number[]; force?: boolean }
  | { kind: 'candidate_check'; repositoryId: number; owner: string; repo: string; candidateSha: string }
  | { kind: 'command'; repositoryId: number; owner: string; repo: string; pr: number; commentId: number; actorId: number; actorLogin: string; command: MergeCommand }
  | { kind: 'ignore'; reason: string };
const controllerCheckPrefix = 'merge-manager/shadow/pr-';
const prActions = new Set(['opened', 'reopened', 'synchronize', 'edited', 'ready_for_review', 'converted_to_draft', 'closed']);
const reviewActions = new Set(['submitted', 'edited', 'dismissed']);
export function parseCommand(body: unknown): MergeCommand | undefined {
  if (typeof body !== 'string') return undefined;
  const match = body.trim().match(/^(?:@merge-manager|\/merge-manager)\s+(ready|land|cancel|retry)\s*$/i);
  return match?.[1]?.toLowerCase() as MergeCommand | undefined;
}
export function routeEvent(event: string, payload: Record<string, any>, controllerAppId: number): Route {
  const repo = payload.repository;
  if (!repo?.id || !repo?.owner?.login || !repo?.name) return { kind: 'ignore', reason: 'missing_repository' };
  let prs: number[] = [];
  if (event === 'pull_request' && prActions.has(payload.action)) prs = [payload.number];
  else if (event === 'pull_request_review' && reviewActions.has(payload.action)) prs = [payload.pull_request?.number];
  else if (event === 'issue_comment' && payload.action === 'created' && payload.issue?.pull_request) {
    const command = parseCommand(payload.comment?.body);
    const values = { pr: payload.issue?.number, commentId: payload.comment?.id, actorId: payload.sender?.id, actorLogin: payload.sender?.login };
    if (!command) return { kind: 'ignore', reason: 'irrelevant_comment' };
    if (!Number.isInteger(values.pr) || !Number.isInteger(values.commentId) || !Number.isInteger(values.actorId) || typeof values.actorLogin !== 'string') return { kind: 'ignore', reason: 'malformed_command' };
    return { kind: 'command', repositoryId: repo.id, owner: repo.owner.login, repo: repo.name, ...values as Required<typeof values>, command };
  }
  else if (event === 'check_run') {
    const own = payload.check_run?.app?.id === controllerAppId && payload.check_run?.name?.startsWith(controllerCheckPrefix);
    if (own && payload.action !== 'rerequested') return { kind: 'ignore', reason: 'controller_check_recursion' };
    if (own && payload.action === 'rerequested') {
      prs = (payload.check_run?.pull_requests ?? []).map((p: any) => p.number);
      const route = prs.filter(Number.isInteger);
      return route.length ? { kind: 'reconcile', repositoryId: repo.id, owner: repo.owner.login, repo: repo.name, prs: route, force: true } : { kind: 'ignore', reason: 'irrelevant_event' };
    }
    if (!own && payload.action === 'completed') {
      const candidateBranch = payload.check_run?.check_suite?.head_branch;
      if (typeof candidateBranch === 'string' && candidateBranch.startsWith('merge-manager/candidates/') && /^[0-9a-f]{40}$/.test(payload.check_run?.head_sha ?? '')) {
        return { kind: 'candidate_check', repositoryId: repo.id, owner: repo.owner.login, repo: repo.name, candidateSha: payload.check_run.head_sha };
      }
      prs = (payload.check_run?.pull_requests ?? []).map((p: any) => p.number);
      if (!prs.length && /^[0-9a-f]{40}$/.test(payload.check_run?.head_sha ?? '')) return { kind: 'candidate_check', repositoryId: repo.id, owner: repo.owner.login, repo: repo.name, candidateSha: payload.check_run.head_sha };
    }
  }
  prs = prs.filter(Number.isInteger);
  return prs.length ? { kind: 'reconcile', repositoryId: repo.id, owner: repo.owner.login, repo: repo.name, prs } : { kind: 'ignore', reason: 'irrelevant_event' };
}
