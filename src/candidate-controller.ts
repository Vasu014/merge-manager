import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Policy } from './policy.js';
import { loadTrustedPolicy } from './trusted-policy.js';
import type { MergeCommand } from './webhook.js';

const CHECK_PREFIX = 'merge-manager/shadow/pr-';
const CANDIDATE_PREFIX = 'merge-manager/candidates';
const allowedPermissions = new Set(['admin', 'maintain', 'write']);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface GitHubApp {
  getInstallationOctokit(id: number): Promise<any>;
  compareAndSwapRef(input: { installationId: number; owner: string; repo: string; ref: string; candidateRef: string; candidateSha: string; expectedSha: string }): Promise<'landed' | 'unknown'>;
}
export interface CommandTarget {
  installationId: number; repositoryId: number; owner: string; repo: string; pr: number;
  commentId: number; actorId: number; actorLogin: string; command: MergeCommand; appId: number;
}

type CandidateRow = {
  id: string; attempt_id: string; repository_id: string; pr_number: number; installation_id: string;
  owner: string; repo: string; target_branch: string; submitted_head_sha: string; assigned_base_sha: string;
  candidate_sha: string | null; candidate_ref: string; policy: Policy; policy_digest: string;
  status: string; reason: string | null; requested_by_id: string; requested_by_login: string;
  active: boolean;
};

export function candidateDecision(
  policy: Policy,
  checks: { name: string; appId?: number; status: string; conclusion?: string | null }[],
): { status: 'VALIDATING' | 'READY' | 'AUTHOR_ACTION'; reason: string } {
  if (!policy.requiredChecks.length) return { status: 'AUTHOR_ACTION', reason: 'no_trusted_checks_configured' };
  for (const required of policy.requiredChecks) {
    if (required.appId === undefined) return { status: 'AUTHOR_ACTION', reason: `untrusted_check_policy:${required.name}` };
    const matches = checks.filter((check) => check.name === required.name && (required.appId === undefined || check.appId === required.appId));
    if (matches.length !== 1) return { status: 'VALIDATING', reason: matches.length ? `ambiguous_check:${required.name}` : `missing_check:${required.name}` };
    const check = matches[0]!;
    if (check.status !== 'completed') return { status: 'VALIDATING', reason: `pending_check:${required.name}` };
    if (check.conclusion !== 'success') return { status: 'AUTHOR_ACTION', reason: `failed_check:${required.name}` };
  }
  return { status: 'READY', reason: 'all_candidate_checks_pass' };
}

export async function handleCommand(app: GitHubApp, pool: Pool, target: CommandTarget): Promise<void> {
  const client = await pool.connect();
  const lockKey = `${target.repositoryId}:${target.pr}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    const inserted = await client.query(`INSERT INTO merge_commands(comment_id,repository_id,pr_number,command,actor_id,actor_login)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING comment_id`, [target.commentId, target.repositoryId, target.pr, target.command, target.actorId, target.actorLogin]);
    if (!inserted.rowCount) {
      const existing = (await client.query('SELECT disposition FROM merge_commands WHERE comment_id=$1', [target.commentId])).rows[0];
      if (existing?.disposition === 'completed') return;
    }
    try {
      const octokit = await app.getInstallationOctokit(target.installationId);
      await requireWritePermission(octokit, target);
      if (target.command === 'land') await land(app, octokit, client, target);
      else if (target.command === 'cancel') await cancel(octokit, client, target);
      else await prepare(octokit, client, target);
      await client.query("UPDATE merge_commands SET processed_at=now(),disposition='completed' WHERE comment_id=$1", [target.commentId]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await client.query("UPDATE merge_commands SET processed_at=now(),disposition='failed',error=$2 WHERE comment_id=$1", [target.commentId, message.slice(0, 4000)]);
      throw error;
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => undefined);
    client.release();
  }
}

async function requireWritePermission(octokit: any, target: CommandTarget): Promise<void> {
  const response = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner: target.owner, repo: target.repo, username: target.actorLogin });
  if (!allowedPermissions.has(response.data.permission)) throw new Error('command_actor_not_authorized');
  if (response.data.user?.id && response.data.user.id !== target.actorId) throw new Error('command_actor_identity_mismatch');
}

async function prepare(octokit: any, client: PoolClient, target: CommandTarget): Promise<void> {
  const common = { owner: target.owner, repo: target.repo };
  const { data: pr } = await octokit.rest.pulls.get({ ...common, pull_number: target.pr });
  if (pr.state !== 'open') throw new Error('pull_request_not_open');
  if (pr.draft) throw new Error('pull_request_is_draft');
  if (pr.head.repo?.fork) throw new Error('fork_requires_human_review');
  const targetBranch = pr.base.ref;
  const assignedBaseSha = (await octokit.rest.git.getRef({ ...common, ref: `heads/${targetBranch}` })).data.object.sha;
  const attemptResult = await client.query('SELECT * FROM attempts WHERE repository_id=$1 AND pr_number=$2 AND active FOR UPDATE', [target.repositoryId, target.pr]);
  const attempt = attemptResult.rows[0];
  if (!attempt || attempt.head_sha !== pr.head.sha || attempt.base_sha !== assignedBaseSha) throw new Error('observer_attempt_is_stale');
  if (attempt.decision?.outcome !== 'eligible') throw new Error(`observer_not_eligible:${attempt.decision?.code ?? 'unknown'}`);
  const trusted = await loadTrustedPolicy(octokit, common, assignedBaseSha);
  if (!trusted.valid) throw new Error('trusted_policy_invalid');

  const previous = await client.query('SELECT * FROM candidates WHERE repository_id=$1 AND pr_number=$2 AND active FOR UPDATE', [target.repositoryId, target.pr]);
  if (previous.rows[0]) await deactivateAndDeleteRef(octokit, client, previous.rows[0], 'SUPERSEDED', 'new_preparation_requested');

  const id = randomUUID();
  const candidateRef = `${CANDIDATE_PREFIX}/pr-${target.pr}/${id}`;
  await client.query(`INSERT INTO candidates(id,attempt_id,repository_id,pr_number,installation_id,owner,repo,target_branch,submitted_head_sha,assigned_base_sha,candidate_ref,policy,policy_digest,status,requested_by_id,requested_by_login)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PREPARING',$14,$15)`, [id, attempt.id, target.repositoryId, target.pr, target.installationId, target.owner, target.repo, targetBranch, pr.head.sha, assignedBaseSha, candidateRef, trusted.policy, digest(trusted.evidence), target.actorId, target.actorLogin]);
  try {
    await octokit.rest.git.createRef({ ...common, ref: `refs/heads/${candidateRef}`, sha: assignedBaseSha });
    let constructedSha: string;
    try {
      const merge = await octokit.rest.repos.merge({ ...common, base: candidateRef, head: pr.head.sha, commit_message: `Merge PR #${target.pr} candidate ${id}` });
      if (!/^[0-9a-f]{40}$/.test(merge.data?.sha ?? '')) throw new Error('merge_api_did_not_return_candidate_sha');
      constructedSha = merge.data.sha;
    } catch (error: any) {
      if (error?.status === 409) {
        await client.query("UPDATE candidates SET status='AUTHOR_ACTION',reason='merge_conflict',updated_at=now() WHERE id=$1", [id]);
        await publishCandidateCheck(octokit, client, target, { id, status: 'AUTHOR_ACTION', reason: 'merge_conflict', candidate_sha: null, assigned_base_sha: assignedBaseSha, submitted_head_sha: pr.head.sha } as CandidateRow);
        return;
      }
      throw error;
    }
    const candidateSha = (await octokit.rest.git.getRef({ ...common, ref: `heads/${candidateRef}` })).data.object.sha;
    if (candidateSha !== constructedSha) throw new Error('candidate_ref_changed_during_preparation');
    await assertExactCandidate(octokit, common, assignedBaseSha, pr.head.sha, candidateSha);
    await client.query("UPDATE candidates SET candidate_sha=$2,status='VALIDATING',reason='waiting_for_candidate_checks',updated_at=now() WHERE id=$1", [id, candidateSha]);
    const row = (await client.query('SELECT * FROM candidates WHERE id=$1', [id])).rows[0] as CandidateRow;
    await refreshCandidateLocked(octokit, client, row, target.appId);
  } catch (error) {
    await client.query("UPDATE candidates SET active=false,status='FAILED',reason=$2,updated_at=now() WHERE id=$1", [id, (error instanceof Error ? error.message : String(error)).slice(0, 1000)]);
    await deleteRef(octokit, common, candidateRef);
    throw error;
  }
}

export async function refreshCandidate(app: GitHubApp, pool: Pool, installationId: number, repositoryId: number, candidateSha: string, appId: number): Promise<void> {
  const client = await pool.connect();
  let lockKey: string | undefined;
  try {
    const initial = await client.query('SELECT pr_number FROM candidates WHERE repository_id=$1 AND candidate_sha=$2 AND active', [repositoryId, candidateSha]);
    if (!initial.rows[0]) return;
    lockKey = `${repositoryId}:${initial.rows[0].pr_number}`;
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    const result = await client.query('SELECT * FROM candidates WHERE repository_id=$1 AND candidate_sha=$2 AND active', [repositoryId, candidateSha]);
    const row = result.rows[0] as CandidateRow | undefined;
    if (!row) return;
    const octokit = await app.getInstallationOctokit(installationId);
    await refreshCandidateLocked(octokit, client, row, appId);
  } finally {
    if (lockKey) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => undefined);
    client.release();
  }
}

async function refreshCandidateLocked(octokit: any, client: PoolClient, row: CandidateRow, appId: number): Promise<void> {
  if (!row.candidate_sha) return;
  const common = { owner: row.owner, repo: row.repo };
  const [pr, base, candidateRef, suites] = await Promise.all([
    octokit.rest.pulls.get({ ...common, pull_number: row.pr_number }),
    octokit.rest.git.getRef({ ...common, ref: `heads/${row.target_branch}` }),
    octokit.rest.git.getRef({ ...common, ref: `heads/${row.candidate_ref}` }).catch((error: any) => error?.status === 404 ? undefined : Promise.reject(error)),
    octokit.paginate(octokit.rest.checks.listSuitesForRef, { ...common, ref: row.candidate_sha, per_page: 100 }),
  ]);
  if (row.status === 'LANDING' && base.data.object.sha === row.candidate_sha) {
    await assertExactCandidate(octokit, common, row.assigned_base_sha, row.submitted_head_sha, row.candidate_sha);
    await finalizeLanding(octokit, client, { owner: row.owner, repo: row.repo, pr: row.pr_number, appId } as CommandTarget, row);
    return;
  }
  if (pr.data.state !== 'open' || pr.data.head.sha !== row.submitted_head_sha || pr.data.base.ref !== row.target_branch || base.data.object.sha !== row.assigned_base_sha || candidateRef?.data.object.sha !== row.candidate_sha) {
    const reason = candidateRef?.data.object.sha !== row.candidate_sha ? 'candidate_ref_moved_or_deleted' : 'pr_head_target_or_base_moved';
    await deactivateAndDeleteRef(octokit, client, row, 'STALE', reason);
    await publishCandidateCheck(octokit, client, { owner: row.owner, repo: row.repo, pr: row.pr_number, appId } as CommandTarget, { ...row, status: 'STALE', reason });
    return;
  }
  const candidateSuites = suites.filter((suite: any) => suite.head_branch === row.candidate_ref && suite.head_sha === row.candidate_sha);
  const checkRuns = (await Promise.all(candidateSuites.map((suite: any) => octokit.paginate(octokit.rest.checks.listForSuite, { ...common, check_suite_id: suite.id, per_page: 100 })))).flat();
  const checks = checkRuns.filter((check: any) => !(check.app?.id === appId && check.name.startsWith(CHECK_PREFIX))).map((check: any) => ({ name: check.name, ...(check.app?.id ? { appId: check.app.id } : {}), status: check.status, conclusion: check.conclusion }));
  const decision = candidateDecision(row.policy, checks);
  await client.query('UPDATE candidates SET status=$2,reason=$3,updated_at=now() WHERE id=$1', [row.id, decision.status, decision.reason]);
  await publishCandidateCheck(octokit, client, { owner: row.owner, repo: row.repo, pr: row.pr_number, appId } as CommandTarget, { ...row, status: decision.status, reason: decision.reason });
}

async function land(app: GitHubApp, octokit: any, client: PoolClient, target: CommandTarget): Promise<void> {
  const result = await client.query('SELECT * FROM candidates WHERE repository_id=$1 AND pr_number=$2 AND active FOR UPDATE', [target.repositoryId, target.pr]);
  const row = result.rows[0] as CandidateRow | undefined;
  if (!row) {
    const completed = await client.query(`SELECT 1 FROM candidates c JOIN merge_commands m ON m.comment_id=$3
      WHERE c.repository_id=$1 AND c.pr_number=$2 AND c.status='LANDED' AND c.landed_at >= m.received_at
      ORDER BY c.landed_at DESC LIMIT 1`, [target.repositoryId, target.pr, target.commentId]);
    if (completed.rows[0]) return;
    throw new Error('candidate_not_ready');
  }
  if (!['READY', 'LANDING'].includes(row.status) || !row.candidate_sha) throw new Error('candidate_not_ready');
  const common = { owner: row.owner, repo: row.repo };
  const initialTarget = (await octokit.rest.git.getRef({ ...common, ref: `heads/${row.target_branch}` })).data.object.sha;
  if (initialTarget === row.candidate_sha && row.status === 'LANDING') {
    await assertExactCandidate(octokit, common, row.assigned_base_sha, row.submitted_head_sha, row.candidate_sha);
    await finalizeLanding(octokit, client, target, row);
    return;
  }
  await refreshCandidateLocked(octokit, client, row, target.appId);
  const refreshed = (await client.query('SELECT * FROM candidates WHERE id=$1', [row.id])).rows[0] as CandidateRow;
  if (!refreshed.active || refreshed.status !== 'READY' || !refreshed.candidate_sha) throw new Error('candidate_became_stale');
  await assertExactCandidate(octokit, common, row.assigned_base_sha, row.submitted_head_sha, refreshed.candidate_sha);
  const [latestPr, latestBase, latestCandidateRef] = await Promise.all([
    octokit.rest.pulls.get({ ...common, pull_number: row.pr_number }),
    octokit.rest.git.getRef({ ...common, ref: `heads/${row.target_branch}` }),
    octokit.rest.git.getRef({ ...common, ref: `heads/${row.candidate_ref}` }),
  ]);
  if (latestPr.data.state !== 'open' || latestPr.data.head.sha !== row.submitted_head_sha || latestPr.data.base.ref !== row.target_branch) throw new Error('pull_request_changed_before_landing');
  if (latestCandidateRef.data.object.sha !== refreshed.candidate_sha) throw new Error('candidate_ref_changed_before_landing');
  const currentBase = latestBase.data.object.sha;
  if (currentBase !== row.assigned_base_sha) throw new Error('target_moved_before_landing');
  await client.query("UPDATE candidates SET status='LANDING',reason='atomic_update_in_progress',updated_at=now() WHERE id=$1", [row.id]);
  const landingResult = await app.compareAndSwapRef({
    installationId: Number(row.installation_id), owner: row.owner, repo: row.repo,
    ref: row.target_branch, candidateRef: row.candidate_ref,
    candidateSha: refreshed.candidate_sha, expectedSha: row.assigned_base_sha,
  });
  const observed = (await octokit.rest.git.getRef({ ...common, ref: `heads/${row.target_branch}` })).data.object.sha;
  if (observed !== refreshed.candidate_sha) {
    if (observed !== row.assigned_base_sha) {
      await deactivateAndDeleteRef(octokit, client, row, 'STALE', 'compare_and_swap_rejected');
      throw new Error('target_moved_during_landing');
    }
    throw new Error(landingResult === 'unknown' ? 'landing_failed_without_ref_change' : 'landing_outcome_unknown');
  }
  await finalizeLanding(octokit, client, target, refreshed);
}

async function finalizeLanding(octokit: any, client: PoolClient, target: CommandTarget, row: CandidateRow): Promise<void> {
  await publishCandidateCheck(octokit, client, target, { ...row, status: 'LANDED', reason: 'landed_exact_candidate' });
  await client.query("UPDATE candidates SET active=false,status='LANDED',reason='landed_exact_candidate',landed_at=now(),updated_at=now() WHERE id=$1", [row.id]);
  await deleteRef(octokit, { owner: row.owner, repo: row.repo }, row.candidate_ref).catch(() => undefined);
}

async function cancel(octokit: any, client: PoolClient, target: CommandTarget): Promise<void> {
  const result = await client.query('SELECT * FROM candidates WHERE repository_id=$1 AND pr_number=$2 AND active FOR UPDATE', [target.repositoryId, target.pr]);
  const row = result.rows[0] as CandidateRow | undefined;
  if (!row) throw new Error('no_active_candidate');
  await deactivateAndDeleteRef(octokit, client, row, 'CANCELLED', 'cancelled_by_authorized_user');
  await publishCandidateCheck(octokit, client, target, { ...row, status: 'CANCELLED', reason: 'cancelled_by_authorized_user' });
}

async function assertExactCandidate(octokit: any, common: { owner: string; repo: string }, base: string, head: string, candidate: string): Promise<void> {
  if (candidate === head) {
    const comparison = await octokit.rest.repos.compareCommitsWithBasehead({ ...common, basehead: `${base}...${head}` });
    if (!['ahead', 'identical'].includes(comparison.data.status) || comparison.data.merge_base_commit.sha !== base) throw new Error('fast_forward_candidate_does_not_descend_from_assigned_base');
    return;
  }
  const commit = (await octokit.rest.git.getCommit({ ...common, commit_sha: candidate })).data;
  if (commit.parents?.length !== 2 || commit.parents[0]?.sha !== base || commit.parents[1]?.sha !== head) throw new Error('candidate_parents_do_not_match_exact_base_and_head');
}

async function deactivateAndDeleteRef(octokit: any, client: PoolClient, row: CandidateRow, status: string, reason: string): Promise<void> {
  await client.query('UPDATE candidates SET active=false,status=$2,reason=$3,updated_at=now() WHERE id=$1', [row.id, status, reason]);
  await deleteRef(octokit, { owner: row.owner, repo: row.repo }, row.candidate_ref);
}

async function deleteRef(octokit: any, common: { owner: string; repo: string }, ref: string): Promise<void> {
  try { await octokit.rest.git.deleteRef({ ...common, ref: `heads/${ref}` }); }
  catch (error: any) { if (error?.status !== 404 && error?.status !== 422) throw error; }
}

async function publishCandidateCheck(octokit: any, client: PoolClient, target: Pick<CommandTarget, 'owner' | 'repo' | 'pr' | 'appId'>, row: CandidateRow): Promise<void> {
  const attempt = (await client.query('SELECT id,check_run_id,head_sha FROM attempts WHERE repository_id=(SELECT repository_id FROM candidates WHERE id=$1) AND pr_number=$2 AND active', [row.id, target.pr])).rows[0];
  if (!attempt) return;
  const complete = !['PREPARING', 'VALIDATING'].includes(row.status);
  const conclusion = row.status === 'READY' || row.status === 'LANDED' ? 'success' : complete ? 'action_required' : undefined;
  const title = row.status === 'READY' ? 'Candidate is ready for authorized landing.' : row.status === 'LANDED' ? 'Exact candidate landed.' : `Candidate status: ${row.status}`;
  const text = [`PR: #${target.pr}`, `Status: ${row.status}`, `Submitted: \`${row.submitted_head_sha}\``, `Base: \`${row.assigned_base_sha}\``, row.candidate_sha ? `Candidate: \`${row.candidate_sha}\`` : undefined, `Reason: \`${row.reason ?? 'none'}\``].filter(Boolean).join('\n\n');
  const input = { owner: target.owner, repo: target.repo, name: `${CHECK_PREFIX}${target.pr}`, check_run_id: attempt.check_run_id, external_id: attempt.id, status: complete ? 'completed' : 'in_progress', ...(conclusion ? { conclusion } : {}), output: { title, summary: `Observed-mode candidate: **${row.status}**`, text } };
  if (attempt.check_run_id) await octokit.rest.checks.update(input);
  else {
    const created = await octokit.rest.checks.create({ ...input, head_sha: attempt.head_sha });
    await client.query('UPDATE attempts SET check_run_id=$2 WHERE id=$1', [attempt.id, created.data.id]);
  }
}
