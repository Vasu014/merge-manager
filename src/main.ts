import { App } from '@octokit/app';
import { Octokit } from 'octokit';
import { Pool } from 'pg';
import { PgBoss, type Job } from 'pg-boss';
import { loadConfig } from './config.js';
import { handleCommand, refreshCandidate } from './candidate-controller.js';
import { migrate } from './database.js';
import { compareAndSwapRef } from './git-lander.js';
import { reconcile } from './reconcile.js';
import { buildServer } from './service.js';
import { routeEvent } from './webhook.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const boss = new PgBoss(config.DATABASE_URL);
const githubApp = new App({ appId: config.GITHUB_APP_ID, privateKey: config.GITHUB_PRIVATE_KEY, Octokit });
const github = {
  getInstallationOctokit: (installationId: number) => githubApp.getInstallationOctokit(installationId),
  compareAndSwapRef: async (input: Omit<Parameters<typeof compareAndSwapRef>[0], 'token'> & { installationId: number }) => {
    const authentication = await githubApp.octokit.auth({ type: 'installation', installationId: input.installationId }) as { token?: string };
    if (typeof authentication.token !== 'string') throw new Error('installation_token_unavailable');
    const { installationId: _installationId, ...request } = input;
    return compareAndSwapRef({ ...request, token: authentication.token });
  },
};
const deliveryQueue = 'process-delivery-v2';
await migrate(pool);
await boss.start();
await boss.createQueue('process-delivery-dead');
await boss.createQueue(deliveryQueue, { retryLimit: 5, retryDelay: 30, retryBackoff: true, deadLetter: 'process-delivery-dead' });
await boss.work<{ deliveryId: string }>(deliveryQueue, async ([job]: Job<{ deliveryId: string }>[]) => {
  if (!job) return;
  const row = (await pool.query('SELECT event,payload FROM webhook_deliveries WHERE delivery_id=$1 AND processed_at IS NULL', [job.data.deliveryId])).rows[0];
  if (!row) return;
  try {
    const route = routeEvent(row.event, row.payload, config.GITHUB_APP_ID);
    if (route.kind === 'ignore') {
      await pool.query('UPDATE webhook_deliveries SET processed_at=now(),disposition=$2,error=NULL WHERE delivery_id=$1', [job.data.deliveryId, route.reason]);
      return;
    }
    const installationId = row.payload.installation?.id;
    if (!Number.isInteger(installationId)) {
      await pool.query("UPDATE webhook_deliveries SET processed_at=now(),disposition='ignored_missing_installation' WHERE delivery_id=$1", [job.data.deliveryId]); return;
    }
    if (route.kind === 'reconcile') {
      for (const pr of route.prs) await reconcile(github, pool, { ...route, pr, installationId, appId: config.GITHUB_APP_ID });
    } else if (route.kind === 'command') {
      await reconcile(github, pool, { ...route, installationId, appId: config.GITHUB_APP_ID });
      await handleCommand(github, pool, { ...route, installationId, appId: config.GITHUB_APP_ID });
    } else {
      await refreshCandidate(github, pool, installationId, route.repositoryId, route.candidateSha, config.GITHUB_APP_ID);
    }
    await pool.query('UPDATE webhook_deliveries SET processed_at=now(),disposition=$2,error=NULL WHERE delivery_id=$1', [job.data.deliveryId, route.kind]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query('UPDATE webhook_deliveries SET error=$2 WHERE delivery_id=$1', [job.data.deliveryId, message.slice(0, 4000)]);
    throw error;
  }
});

let dispatching = false;
async function dispatch() {
  if (dispatching) return; dispatching = true;
  try {
    await pool.query("UPDATE webhook_deliveries SET job_id=gen_random_uuid(),enqueued_at=NULL WHERE processed_at IS NULL AND enqueued_at < now() - interval '15 minutes'");
    const rows = await pool.query('SELECT delivery_id,job_id FROM webhook_deliveries WHERE enqueued_at IS NULL AND processed_at IS NULL ORDER BY received_at LIMIT 100');
    for (const row of rows.rows) {
      await boss.send(deliveryQueue, { deliveryId: row.delivery_id }, { id: row.job_id });
      await pool.query('UPDATE webhook_deliveries SET enqueued_at=now() WHERE delivery_id=$1 AND enqueued_at IS NULL', [row.delivery_id]);
    }
  } finally { dispatching = false; }
}
await dispatch();
const timer = setInterval(() => void dispatch().catch(console.error), config.DISPATCH_INTERVAL_MS);

let sweeping = false;
async function sweep() {
  if (sweeping) return; sweeping = true;
  try {
    const rows = await pool.query("SELECT repository_id,pr_number,owner,repo,installation_id FROM pull_requests WHERE state='open' ORDER BY updated_at");
    for (const row of rows.rows) {
      await reconcile(github, pool, { repositoryId: Number(row.repository_id), pr: row.pr_number, owner: row.owner, repo: row.repo, installationId: Number(row.installation_id), appId: config.GITHUB_APP_ID }).catch(console.error);
    }
    const candidates = await pool.query("SELECT repository_id,installation_id,candidate_sha FROM candidates WHERE active AND candidate_sha IS NOT NULL ORDER BY updated_at");
    for (const row of candidates.rows) {
      await refreshCandidate(github, pool, Number(row.installation_id), Number(row.repository_id), row.candidate_sha, config.GITHUB_APP_ID).catch(console.error);
    }
  } finally { sweeping = false; }
}
await sweep();
const sweepTimer = setInterval(() => void sweep().catch(console.error), config.RECONCILE_INTERVAL_MS);
const server = buildServer(config, pool, boss);
await server.listen({ host: config.HOST, port: config.PORT });
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true; clearInterval(timer); clearInterval(sweepTimer);
  await server.close(); await boss.stop({ graceful: true }); await pool.end();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
