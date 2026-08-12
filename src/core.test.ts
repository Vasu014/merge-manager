import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { candidateDecision } from './candidate-controller.js';
import { checkOutput } from './check-output.js';
import { evaluate, type Facts } from './evaluator.js';
import { defaultPolicy, policySchema } from './policy.js';
import { loadTrustedPolicy } from './trusted-policy.js';
import { parseCommand, routeEvent, verifySignature } from './webhook.js';

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
  it('routes a command only from a PR issue comment', () => expect(routeEvent('issue_comment', { ...base, action: 'created', issue: { number: 4, pull_request: {} }, comment: { id: 8, body: '@merge-manager ready' }, sender: { id: 3, login: 'alice' } }, 9)).toMatchObject({ kind: 'command', command: 'ready', pr: 4, actorId: 3 }));
  it('routes candidate checks without associated pull requests', () => expect(routeEvent('check_run', { ...base, action: 'completed', check_run: { name: 'test', head_sha: 'a'.repeat(40), app: { id: 10 }, pull_requests: [] } }, 9)).toMatchObject({ kind: 'candidate_check', candidateSha: 'a'.repeat(40) }));
  it('routes candidate checks even when GitHub associates the merge commit with a PR', () => expect(routeEvent('check_run', { ...base, action: 'completed', check_run: { name: 'test', head_sha: 'a'.repeat(40), app: { id: 10 }, check_suite: { head_branch: 'merge-manager/candidates/pr-4/id' }, pull_requests: [{ number: 4 }] } }, 9)).toMatchObject({ kind: 'candidate_check', candidateSha: 'a'.repeat(40) }));
});
describe('commands', () => {
  it.each(['ready', 'land', 'cancel', 'retry'] as const)('parses %s exactly', (command) => expect(parseCommand(`@merge-manager ${command}`)).toBe(command));
  it('does not accept commands embedded in prose', () => expect(parseCommand('please @merge-manager land now')).toBeUndefined());
});
describe('policy', () => {
  it('rejects unknown fields instead of silently weakening policy', () => expect(() => policySchema.parse({ requiredCheks: [] })).toThrow());
  it('loads policy from the exact trusted base passed by the controller', async () => {
    let observedRef = '';
    const raw = JSON.stringify({ requiredChecks: [{ name: 'ci', appId: 15368 }] });
    const octokit = { rest: { repos: { getContent: async ({ ref }: { ref: string }) => { observedRef = ref; return { data: { type: 'file', encoding: 'base64', content: Buffer.from(raw).toString('base64') } }; } } } };
    const result = await loadTrustedPolicy(octokit, { owner: 'o', repo: 'r' }, 'current-target-sha');
    expect(observedRef).toBe('current-target-sha');
    expect(result).toMatchObject({ valid: true, policy: { requiredChecks: [{ name: 'ci', appId: 15368 }] } });
  });
  it('fails closed on malformed trusted policy', async () => {
    const octokit = { rest: { repos: { getContent: async () => ({ data: { type: 'file', encoding: 'base64', content: Buffer.from('{bad').toString('base64') } }) } } };
    expect(await loadTrustedPolicy(octokit, { owner: 'o', repo: 'r' }, 'base')).toMatchObject({ valid: false });
  });
});
describe('check output', () => {
  it.each([['waiting','in_progress',undefined],['eligible','completed','success'],['author_action','completed','action_required'],['human_review','completed','action_required']] as const)('%s mapping', (outcome,status,conclusion) => expect(checkOutput({ outcome, code: 'x', message: 'x' })).toMatchObject({ status, ...(conclusion ? { conclusion } : {}) }));
});
describe('candidate validation', () => {
  const policy = { ...defaultPolicy, requiredChecks: [{ name: 'ci', appId: 15368 }] };
  it('fails closed when no trusted candidate checks are configured', () => expect(candidateDecision(defaultPolicy, []).reason).toBe('no_trusted_checks_configured'));
  it('waits for an exact required check', () => expect(candidateDecision(policy, []).status).toBe('VALIDATING'));
  it('rejects a failing candidate check', () => expect(candidateDecision(policy, [{ name: 'ci', appId: 15368, status: 'completed', conclusion: 'failure' }])).toEqual({ status: 'AUTHOR_ACTION', reason: 'failed_check:ci' }));
  it('accepts only a successful candidate check', () => expect(candidateDecision(policy, [{ name: 'ci', appId: 15368, status: 'completed', conclusion: 'success' }]).status).toBe('READY'));
  it('refuses ambiguous checks', () => expect(candidateDecision(policy, [{ name: 'ci', appId: 15368, status: 'completed', conclusion: 'success' }, { name: 'ci', appId: 15368, status: 'completed', conclusion: 'success' }]).status).toBe('VALIDATING'));
  it('refuses a policy that does not bind checks to an app', () => expect(candidateDecision({ ...defaultPolicy, requiredChecks: [{ name: 'ci' }] }, []).reason).toBe('untrusted_check_policy:ci'));
});
