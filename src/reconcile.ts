import { createHash, randomUUID } from 'node:crypto';
import type { Octokit } from 'octokit';
import type { Pool, PoolClient } from 'pg';
import { checkOutput } from './check-output.js';
import { transactionOnClient } from './database.js';
import { evaluate, type Decision, type Facts } from './evaluator.js';
import { loadTrustedPolicy } from './trusted-policy.js';

const CHECK_PREFIX = 'merge-manager/shadow/pr-';
const VERSION = 'observer-v1';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface GitHubApp { getInstallationOctokit(id: number): Promise<Octokit> }
type Target = { installationId: number; repositoryId: number; owner: string; repo: string; pr: number; appId: number; force?: boolean };

export async function reconcile(app: GitHubApp, pool: Pool, target: Target): Promise<void> {
  const client = await pool.connect();
  const lockKey = `${target.repositoryId}:${target.pr}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    await reconcileLocked(app, client, target);
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => undefined);
    client.release();
  }
}

async function reconcileLocked(app: GitHubApp, client: PoolClient, target: Target): Promise<void> {
  const octokit = await app.getInstallationOctokit(target.installationId);
  const common = { owner: target.owner, repo: target.repo };
  const checkName = `${CHECK_PREFIX}${target.pr}`;
  const { data: pr } = await octokit.rest.pulls.get({ ...common, pull_number: target.pr });
  const targetBranch = pr.base.ref;
  const assignedBaseSha = (await octokit.rest.git.getRef({ ...common, ref: `heads/${targetBranch}` })).data.object.sha;
  if (pr.state !== 'open') {
    await transactionOnClient(client, async () => {
      await client.query(`INSERT INTO pull_requests(repository_id,pr_number,owner,repo,installation_id,head_sha,base_sha,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(repository_id,pr_number) DO UPDATE SET owner=$3,repo=$4,installation_id=$5,head_sha=$6,base_sha=$7,state=$8,updated_at=now()`, [target.repositoryId, target.pr, target.owner, target.repo, target.installationId, pr.head.sha, assignedBaseSha, pr.state]);
      await client.query('UPDATE attempts SET active=false,superseded_at=now() WHERE repository_id=$1 AND pr_number=$2 AND active', [target.repositoryId, target.pr]);
    });
    return;
  }
  const [files, reviews, suites] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listFiles, { ...common, pull_number: target.pr, per_page: 100 }),
    octokit.paginate(octokit.rest.pulls.listReviews, { ...common, pull_number: target.pr, per_page: 100 }),
    octokit.paginate(octokit.rest.checks.listSuitesForRef, { ...common, ref: pr.head.sha, per_page: 100 }),
  ]);
  const prSuites = suites.filter((suite) => suite.head_branch === pr.head.ref && suite.head_sha === pr.head.sha);
  const checks = (await Promise.all(prSuites.map((suite) => octokit.paginate(octokit.rest.checks.listForSuite, { ...common, check_suite_id: suite.id, per_page: 100 })))).flat();
  const trustedPolicy = await loadTrustedPolicy(octokit, common, assignedBaseSha);
  const policy = trustedPolicy.policy;
  const policyEvidence = trustedPolicy.evidence;
  const policyDecision: Decision | undefined = trustedPolicy.valid ? undefined : { outcome: 'human_review', code: 'invalid_policy', message: 'The trusted merge policy is invalid and requires human review.' };
  const checkFacts: Facts['checks'] = checks.filter((c) => !(c.app?.id === target.appId && c.name.startsWith(CHECK_PREFIX))).map((c) => ({ name: c.name, ...(c.app?.id ? { appId: c.app.id } : {}), status: c.status, conclusion: c.conclusion }));
  const latestReviews = new Map<number, string>();
  for (const review of reviews) {
    if (!review.user?.id) continue;
    const state = review.state.toUpperCase();
    if (state === 'APPROVED' || state === 'CHANGES_REQUESTED') latestReviews.set(review.user.id, state);
    else if (state === 'DISMISSED') latestReviews.delete(review.user.id);
  }
  const changedPaths = files.flatMap((file) => file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]);
  const facts: Facts = { draft: pr.draft ?? true, fork: pr.head.repo?.fork ?? true, mergeable: pr.mergeable, files: changedPaths, additions: pr.additions, deletions: pr.deletions, reviews: [...latestReviews.values()].map((state) => ({ state })), checks: checkFacts };
  const decision = policyDecision ?? evaluate(facts, policy);
  const attempt = await transactionOnClient(client, async () => {
    await client.query(`INSERT INTO pull_requests(repository_id,pr_number,owner,repo,installation_id,head_sha,base_sha,state) VALUES($1,$2,$3,$4,$5,$6,$7,'open')
      ON CONFLICT(repository_id,pr_number) DO UPDATE SET owner=$3,repo=$4,installation_id=$5,head_sha=$6,base_sha=$7,state='open',updated_at=now()`, [target.repositoryId, target.pr, target.owner, target.repo, target.installationId, pr.head.sha, assignedBaseSha]);
    const pd = digest(policyEvidence), fd = digest(facts), dd = digest(decision);
    const current = await client.query('SELECT * FROM attempts WHERE repository_id=$1 AND pr_number=$2 AND active FOR UPDATE', [target.repositoryId, target.pr]);
    const row = current.rows[0];
    if (row && row.head_sha === pr.head.sha && row.base_sha === assignedBaseSha && row.policy_digest === pd && row.evaluator_version === VERSION) {
      await client.query('UPDATE attempts SET facts=$2,decision=$3,facts_digest=$4,decision_digest=$5 WHERE id=$1', [row.id, facts, decision, fd, dd]);
      return { ...row, decision, decision_digest: dd };
    }
    await client.query('UPDATE attempts SET active=false,superseded_at=now() WHERE repository_id=$1 AND pr_number=$2 AND active', [target.repositoryId, target.pr]);
    const id = randomUUID();
    await client.query('INSERT INTO attempts(id,repository_id,pr_number,head_sha,base_sha,policy_digest,evaluator_version,facts,decision,facts_digest,decision_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id,target.repositoryId,target.pr,pr.head.sha,assignedBaseSha,pd,VERSION,facts,decision,fd,dd]);
    return { id, check_run_id: null, output_digest: null, decision, decision_digest: dd };
  });
  const output = checkOutput(decision), outputDigest = digest(output);
  if (attempt.output_digest === outputDigest && !target.force) return;
  const stillActive = await client.query('SELECT active FROM attempts WHERE id=$1 AND head_sha=$2', [attempt.id, pr.head.sha]);
  if (!stillActive.rows[0]?.active) return;
  const [latest, latestBase] = await Promise.all([
    octokit.rest.pulls.get({ ...common, pull_number: target.pr }),
    octokit.rest.git.getRef({ ...common, ref: `heads/${targetBranch}` }),
  ]);
  if (latest.data.state !== 'open' || latest.data.head.sha !== pr.head.sha || latest.data.base.ref !== targetBranch || latestBase.data.object.sha !== assignedBaseSha) return;
  let checkId = attempt.check_run_id as number | null;
  if (!checkId) {
    const existing = checks.find((c) => c.name === checkName && c.app?.id === target.appId && c.external_id === attempt.id);
    checkId = existing?.id ?? null;
  }
  const checkData = { name: checkName, external_id: attempt.id, ...output, output: { ...output.output, text: `Pull request: #${target.pr}\n\nTarget: \`${targetBranch}\`\n\nAssigned base: \`${assignedBaseSha}\`` } };
  if (checkId) await octokit.rest.checks.update({ ...common, check_run_id: checkId, ...checkData });
  else {
    try { checkId = (await octokit.rest.checks.create({ ...common, head_sha: pr.head.sha, ...checkData })).data.id; }
    catch (error) {
      const ownedChecks = await octokit.paginate(octokit.rest.checks.listForRef, { ...common, ref: pr.head.sha, app_id: target.appId, check_name: checkName, filter: 'all', per_page: 100 });
      const found = ownedChecks.find((c) => c.app?.id === target.appId && c.external_id === attempt.id);
      if (!found) throw error; checkId = found.id;
    }
  }
  await client.query('UPDATE attempts SET check_run_id=$2,output_digest=$3 WHERE id=$1 AND active', [attempt.id, checkId, outputDigest]);
}
