import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleCommand } from './candidate-controller.js';
import { migrate } from './database.js';

const connectionString = process.env.INTEGRATION_DATABASE_URL;
const integration = describe.skipIf(!connectionString);
const baseSha = '1'.repeat(40);
const headSha = '2'.repeat(40);
const candidateSha = '3'.repeat(40);

function github(repositoryId: number, pr: number, permission = 'write', mutateCandidateRef = false) {
  let currentBase = baseSha;
  let targetBranch = 'main';
  let candidateRefMoved = mutateCandidateRef;
  let moveBaseDuringLand = false;
  let loseLandingResponse = false;
  let losePostLandingRead = false;
  let failNextTargetRead = false;
  let candidateRef = '';
  let candidateRefSha = '';
  const updates: { ref: string; sha: string; force: boolean }[] = [];
  const deleted: string[] = [];
  const checks: any[] = [];
  const policy = Buffer.from(JSON.stringify({ requiredChecks: [{ name: 'ci', appId: 15368 }] })).toString('base64');
  const rest = {
    repos: {
      getCollaboratorPermissionLevel: async () => ({ data: { permission, user: { id: 7 } } }),
      getContent: async () => ({ data: { type: 'file', encoding: 'base64', content: policy } }),
      merge: async ({ base }: { base: string }) => { candidateRefSha = candidateSha; candidateRef = base; return { data: { sha: candidateSha } }; },
      compareCommitsWithBasehead: async ({ basehead }: { basehead: string }) => ({ data: { status: 'ahead', merge_base_commit: { sha: basehead.startsWith(baseSha) ? baseSha : headSha } } }),
    },
    pulls: { get: async () => ({ data: { state: 'open', draft: false, head: { sha: headSha, repo: { fork: false } }, base: { ref: targetBranch } } }) },
    git: {
      getRef: async ({ ref }: { ref: string }) => {
        if (ref === 'heads/main' && failNextTargetRead) { failNextTargetRead = false; throw new Error('simulated_transport_failure'); }
        return { data: { object: { sha: ref === 'heads/main' ? currentBase : candidateRefMoved && candidateRefSha === candidateSha ? '5'.repeat(40) : candidateRefSha } } };
      },
      getCommit: async () => ({ data: { parents: [{ sha: baseSha }, { sha: headSha }] } }),
      createRef: async ({ ref, sha }: { ref: string; sha: string }) => { candidateRef = ref.replace('refs/heads/', ''); candidateRefSha = sha; return { data: {} }; },
      deleteRef: async ({ ref }: { ref: string }) => { deleted.push(ref); return { data: {} }; },
    },
    checks: {
      listSuitesForRef: async () => undefined,
      listForSuite: async () => undefined,
      update: async (input: any) => { checks.push(input); return { data: {} }; },
      create: async (input: any) => { checks.push(input); return { data: { id: 99 } }; },
    },
  };
  const octokit = {
    rest,
    paginate: async (method: unknown) => method === rest.checks.listSuitesForRef
      ? [{ id: 88, head_branch: candidateRef, head_sha: candidateSha }]
      : [{ name: 'ci', app: { id: 15368 }, status: 'completed', conclusion: 'success' }],
  };
  const app = {
    getInstallationOctokit: async () => octokit,
    compareAndSwapRef: async (input: { ref: string; candidateSha: string; expectedSha: string }) => {
      if (moveBaseDuringLand) currentBase = '4'.repeat(40);
      if (currentBase !== input.expectedSha) return 'unknown' as const;
      updates.push({ ref: `heads/${input.ref}`, sha: input.candidateSha, force: false });
      currentBase = input.candidateSha;
      if (losePostLandingRead) failNextTargetRead = true;
      return loseLandingResponse ? 'unknown' as const : 'landed' as const;
    },
  };
  return {
    app, updates, deleted, checks,
    moveBase: () => { currentBase = '4'.repeat(40); },
    moveBaseDuringLand: () => { moveBaseDuringLand = true; },
    loseLandingResponse: () => { loseLandingResponse = true; },
    losePostLandingRead: () => { losePostLandingRead = true; },
    moveCandidateRef: () => { candidateRefMoved = true; },
    retarget: () => { targetBranch = 'release'; }, repositoryId, pr,
  };
}

integration('observed-mode candidate lifecycle', () => {
  const pool = new Pool({ connectionString });
  beforeAll(async () => migrate(pool));
  afterAll(async () => pool.end());

  async function seed(repositoryId: number, pr: number) {
    const attemptId = randomUUID();
    await pool.query(`INSERT INTO attempts(id,repository_id,pr_number,head_sha,base_sha,policy_digest,evaluator_version,facts,decision,facts_digest,decision_digest)
      VALUES($1,$2,$3,$4,$5,'p','test', '{}', '{"outcome":"eligible","code":"all_gates_pass","message":"ok"}', 'f','d')`, [attemptId, repositoryId, pr, headSha, baseSha]);
    return attemptId;
  }

  it('lands only the exact ready candidate with a non-force update', async () => {
    const repositoryId = Date.now(); const pr = 101;
    await seed(repositoryId, pr);
    const fake = github(repositoryId, pr);
    const target = { installationId: 1, repositoryId, owner: 'o', repo: 'r', pr, actorId: 7, actorLogin: 'alice', appId: 9 };
    await handleCommand(fake.app, pool, { ...target, commentId: repositoryId, command: 'ready' });
    expect((await pool.query('SELECT status,candidate_sha FROM candidates WHERE repository_id=$1', [repositoryId])).rows[0]).toEqual({ status: 'READY', candidate_sha: candidateSha });
    const landCommand = { ...target, commentId: repositoryId + 1, command: 'land' as const };
    await handleCommand(fake.app, pool, landCommand);
    await handleCommand(fake.app, pool, landCommand);
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]).toMatchObject({ ref: 'heads/main', sha: candidateSha, force: false });
    expect((await pool.query('SELECT active,status,reason FROM candidates WHERE repository_id=$1', [repositoryId])).rows[0]).toEqual({ active: false, status: 'LANDED', reason: 'landed_exact_candidate' });
    expect(fake.deleted.some((ref) => ref.startsWith('heads/merge-manager/candidates/pr-101/'))).toBe(true);
  });

  it('refuses landing and deletes the candidate ref when the target moved', async () => {
    const repositoryId = Date.now() + 10; const pr = 102;
    await seed(repositoryId, pr);
    const fake = github(repositoryId, pr);
    const target = { installationId: 1, repositoryId, owner: 'o', repo: 'r', pr, actorId: 7, actorLogin: 'alice', appId: 9 };
    await handleCommand(fake.app, pool, { ...target, commentId: repositoryId, command: 'ready' });
    fake.moveBase();
    await expect(handleCommand(fake.app, pool, { ...target, commentId: repositoryId + 1, command: 'land' })).rejects.toThrow('candidate_became_stale');
    expect(fake.updates).toEqual([]);
    expect((await pool.query('SELECT active,status,reason FROM candidates WHERE repository_id=$1', [repositoryId])).rows[0]).toEqual({ active: false, status: 'STALE', reason: 'pr_head_target_or_base_moved' });
  });

  it('rejects commands from actors without repository write permission', async () => {
    const repositoryId = Date.now() + 20; const pr = 103;
    await seed(repositoryId, pr);
    const fake = github(repositoryId, pr, 'read');
    await expect(handleCommand(fake.app, pool, { installationId: 1, repositoryId, owner: 'o', repo: 'r', pr, actorId: 7, actorLogin: 'alice', appId: 9, commentId: repositoryId, command: 'ready' })).rejects.toThrow('command_actor_not_authorized');
    expect((await pool.query('SELECT count(*)::int AS count FROM candidates WHERE repository_id=$1', [repositoryId])).rows[0].count).toBe(0);
  });

  it('rejects a candidate ref changed after GitHub constructs the merge', async () => {
    const repositoryId = Date.now() + 30; const pr = 104;
    await seed(repositoryId, pr);
    const fake = github(repositoryId, pr, 'write', true);
    await expect(handleCommand(fake.app, pool, { installationId: 1, repositoryId, owner: 'o', repo: 'r', pr, actorId: 7, actorLogin: 'alice', appId: 9, commentId: repositoryId, command: 'ready' })).rejects.toThrow('candidate_ref_changed_during_preparation');
    expect((await pool.query('SELECT active,status,reason FROM candidates WHERE repository_id=$1', [repositoryId])).rows[0]).toMatchObject({ active: false, status: 'FAILED' });
  });

  it('stales a candidate when the pull request is retargeted', async () => {
    const repositoryId = Date.now() + 40; const pr = 105;
    await seed(repositoryId, pr);
    const fake = github(repositoryId, pr);
    const target = { installationId: 1, repositoryId, owner: 'o', repo: 'r', pr, actorId: 7, actorLogin: 'alice', appId: 9 };
    await handleCommand(fake.app, pool, { ...target, commentId: repositoryId, command: 'ready' });
    fake.retarget();
    await expect(handleCommand(fake.app, pool, { ...target, commentId: repositoryId + 1, command: 'land' })).rejects.toThrow('candidate_became_stale');
    expect(fake.updates).toEqual([]);
    expect((await pool.query('SELECT active,status,reason FROM candidates WHERE repository_id=$1', [repositoryId])).rows[0]).toEqual({ active: false, status: 'STALE', reason: 'pr_head_target_or_base_moved' });
  });

  it('stales a candidate whose controlled ref moved after validation', async () => {
    const repositoryId = Date.now() + 50; const pr = 106;
    await seed(repositoryId, pr);
    const fake = github(repositoryId, pr);
    const target = { installationId: 1, repositoryId, owner: 'o', repo: 'r', pr, actorId: 7, actorLogin: 'alice', appId: 9 };
    await handleCommand(fake.app, pool, { ...target, commentId: repositoryId, command: 'ready' });
    fake.moveCandidateRef();
    await expect(handleCommand(fake.app, pool, { ...target, commentId: repositoryId + 1, command: 'land' })).rejects.toThrow('candidate_became_stale');
    expect(fake.updates).toEqual([]);
    expect((await pool.query('SELECT active,status,reason FROM candidates WHERE repository_id=$1', [repositoryId])).rows[0]).toEqual({ active: false, status: 'STALE', reason: 'candidate_ref_moved_or_deleted' });
  });

  it('atomically refuses a target movement during the final landing operation', async () => {
    const repositoryId = Date.now() + 60; const pr = 107;
    await seed(repositoryId, pr);
    const fake = github(repositoryId, pr);
    const target = { installationId: 1, repositoryId, owner: 'o', repo: 'r', pr, actorId: 7, actorLogin: 'alice', appId: 9 };
    await handleCommand(fake.app, pool, { ...target, commentId: repositoryId, command: 'ready' });
    fake.moveBaseDuringLand();
    await expect(handleCommand(fake.app, pool, { ...target, commentId: repositoryId + 1, command: 'land' })).rejects.toThrow('target_moved_during_landing');
    expect(fake.updates).toEqual([]);
    expect((await pool.query('SELECT active,status,reason FROM candidates WHERE repository_id=$1', [repositoryId])).rows[0]).toEqual({ active: false, status: 'STALE', reason: 'compare_and_swap_rejected' });
  });

  it('records a landing when the atomic push succeeded but its result was uncertain', async () => {
    const repositoryId = Date.now() + 70; const pr = 108;
    await seed(repositoryId, pr);
    const fake = github(repositoryId, pr);
    const target = { installationId: 1, repositoryId, owner: 'o', repo: 'r', pr, actorId: 7, actorLogin: 'alice', appId: 9 };
    await handleCommand(fake.app, pool, { ...target, commentId: repositoryId, command: 'ready' });
    fake.loseLandingResponse();
    await handleCommand(fake.app, pool, { ...target, commentId: repositoryId + 1, command: 'land' });
    expect(fake.updates).toHaveLength(1);
    expect((await pool.query('SELECT active,status,reason FROM candidates WHERE repository_id=$1', [repositoryId])).rows[0]).toEqual({ active: false, status: 'LANDED', reason: 'landed_exact_candidate' });
  });

  it('recovers an applied landing after the post-push target read failed', async () => {
    const repositoryId = Date.now() + 80; const pr = 109;
    await seed(repositoryId, pr);
    const fake = github(repositoryId, pr);
    const target = { installationId: 1, repositoryId, owner: 'o', repo: 'r', pr, actorId: 7, actorLogin: 'alice', appId: 9 };
    await handleCommand(fake.app, pool, { ...target, commentId: repositoryId, command: 'ready' });
    fake.losePostLandingRead();
    const landCommand = { ...target, commentId: repositoryId + 1, command: 'land' as const };
    await expect(handleCommand(fake.app, pool, landCommand)).rejects.toThrow('simulated_transport_failure');
    await handleCommand(fake.app, pool, landCommand);
    expect(fake.updates).toHaveLength(1);
    expect((await pool.query('SELECT active,status,reason FROM candidates WHERE repository_id=$1', [repositoryId])).rows[0]).toEqual({ active: false, status: 'LANDED', reason: 'landed_exact_candidate' });
  });
});
