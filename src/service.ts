import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import type { Config } from './config.js';
import { verifySignature } from './webhook.js';

export function buildServer(config: Config, pool: Pool, boss: PgBoss) {
  const server = Fastify({ logger: true, bodyLimit: 25 * 1024 * 1024 });
  server.removeContentTypeParser('application/json');
  server.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  server.get('/health', async (_request, reply) => {
    try { await pool.query('SELECT 1'); return { ready: true, database: 'ready', queue: 'started' }; }
    catch { return reply.code(503).send({ ready: false, database: 'unavailable' }); }
  });
  server.post('/github/webhooks', async (request, reply) => {
    const body = request.body as Buffer;
    const signature = request.headers['x-hub-signature-256'] as string | undefined;
    const delivery = request.headers['x-github-delivery'] as string | undefined;
    const event = request.headers['x-github-event'] as string | undefined;
    if (!verifySignature(body, signature, config.GITHUB_WEBHOOK_SECRET)) return reply.code(401).send({ error: 'invalid signature' });
    if (!delivery || !event) return reply.code(400).send({ error: 'missing delivery headers' });
    let payload: unknown;
    try { payload = JSON.parse(body.toString('utf8')); } catch { return reply.code(400).send({ error: 'invalid JSON' }); }
    await pool.query('INSERT INTO webhook_deliveries(delivery_id,event,payload,job_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [delivery, event, payload, randomUUID()]);
    return reply.code(202).send({ accepted: true });
  });
  return server;
}
