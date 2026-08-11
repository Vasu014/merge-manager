import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkOutput } from './check-output.js';
import { evaluate, type Facts } from './evaluator.js';
import { defaultPolicy, policySchema } from './policy.js';
import { routeEvent, verifySignature } from './webhook.js';

const facts = (): Facts => ({ draft: false, fork: false, mergeable: true, files: ['src/a.ts'], additions: 1, deletions: 1, reviews: [], checks: [] });
describe('signature verification', () => {
  it('accepts exact signed bytes and rejects changes/malformed signatures', () => {
    const body = Buffer.from('{"x":1}'), secret = 'test-secret';
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(verifySignature(body, signature, secret)).toBe(true);
    expect(verifySignature(Buffer.from('{"x":2}'), signature, secret)).toBe(false);
    expect(verifySignature(body, 'sha256=nope', secret)).toBe(false);
  });
});
describe('evaluator', () => {
  it.each([
    [{ fork: true }, 'human_review', 'fork'], [{ files: ['.agents/setup'] }, 'human_review', 'sensitive_files'],
    [{ additions: 99999 }, 'author_action', 'oversized'], [{ reviews: [{ state: 'CHANGES_REQUESTED' }] }, 'author_action', 'changes_requested'],
    [{ mergeable: false }, 'author_action', 'merge_conflict'], [{ draft: true }, 'waiting', 'draft'], [{ mergeable: null }, 'waiting', 'mergeability_unknown'],
  ])('maps facts to stable outcomes', (change, outcome, code) => expect(evaluate({ ...facts(), ...change }, defaultPolicy)).toMatchObject({ outcome, code }));
  it('is eligible only when all gates pass', () => expect(evaluate(facts(), defaultPolicy).outcome).toBe('eligible'));
  it('waits for required checks', () => expect(evaluate(facts(), { ...defaultPolicy, requiredChecks: [{ name: 'ci' }] }).code).toBe('missing_required_check'));
  it('requires an explicit success conclusion', () => {
    const policy = { ...defaultPolicy, requiredChecks: [{ name: 'ci' }] };
    const input = { ...facts(), checks: [{ name: 'ci', status: 'completed', conclusion: 'neutral' }] };
    expect(evaluate(input, policy).code).toBe('required_check_failed');
  });
});
describe('routing', () => {
  const base = { repository: { id: 1, name: 'r', owner: { login: 'o' } }, installation: { id: 2 } };
  it('routes PR and review signals', () => expect(routeEvent('pull_request', { ...base, action: 'opened', number: 4 }, 9)).toMatchObject({ kind: 'reconcile', prs: [4] }));
  it('filters own completed checks', () => expect(routeEvent('check_run', { ...base, action: 'completed', check_run: { name: 'merge-manager/shadow/pr-4', app: { id: 9 } } }, 9)).toEqual({ kind: 'ignore', reason: 'controller_check_recursion' }));
  it('forces publication for own rerequests', () => expect(routeEvent('check_run', { ...base, action: 'rerequested', check_run: { name: 'merge-manager/shadow/pr-4', app: { id: 9 }, pull_requests: [{ number: 4 }] } }, 9)).toMatchObject({ kind: 'reconcile', force: true }));
  it('does not treat another app with the same check name as its own', () => expect(routeEvent('check_run', { ...base, action: 'completed', check_run: { name: 'merge-manager/shadow/pr-4', app: { id: 10 }, pull_requests: [{ number: 4 }] } }, 9).kind).toBe('reconcile'));
});
describe('policy', () => {
  it('rejects unknown fields instead of silently weakening policy', () => expect(() => policySchema.parse({ requiredCheks: [] })).toThrow());
});
describe('check output', () => {
  it.each([['waiting','in_progress',undefined],['eligible','completed','success'],['author_action','completed','action_required'],['human_review','completed','action_required']] as const)('%s mapping', (outcome,status,conclusion) => expect(checkOutput({ outcome, code: 'x', message: 'x' })).toMatchObject({ status, ...(conclusion ? { conclusion } : {}) }));
});
