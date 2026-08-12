import { Pool, type PoolClient } from 'pg';

export const migration = `
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id text PRIMARY KEY, event text NOT NULL, payload jsonb NOT NULL,
  job_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), enqueued_at timestamptz,
  processed_at timestamptz, disposition text, error text
);
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS job_id uuid;
UPDATE webhook_deliveries SET job_id = gen_random_uuid() WHERE job_id IS NULL;
ALTER TABLE webhook_deliveries ALTER COLUMN job_id SET NOT NULL;
CREATE TABLE IF NOT EXISTS pull_requests (
  repository_id bigint NOT NULL, pr_number integer NOT NULL, owner text NOT NULL, repo text NOT NULL,
  installation_id bigint NOT NULL, head_sha text, base_sha text, updated_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'open',
  PRIMARY KEY(repository_id, pr_number)
);
ALTER TABLE pull_requests ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'open';
CREATE TABLE IF NOT EXISTS attempts (
  id uuid PRIMARY KEY, repository_id bigint NOT NULL, pr_number integer NOT NULL,
  head_sha text NOT NULL, base_sha text NOT NULL, policy_digest text NOT NULL, evaluator_version text NOT NULL,
  active boolean NOT NULL DEFAULT true, facts jsonb NOT NULL, decision jsonb NOT NULL,
  facts_digest text NOT NULL, decision_digest text NOT NULL, check_run_id bigint, output_digest text,
  created_at timestamptz NOT NULL DEFAULT now(), superseded_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS attempts_one_active_pr ON attempts(repository_id, pr_number) WHERE active;
DROP INDEX IF EXISTS attempts_identity;
CREATE TABLE IF NOT EXISTS candidates (
  id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES attempts(id),
  repository_id bigint NOT NULL, pr_number integer NOT NULL, installation_id bigint NOT NULL,
  owner text NOT NULL, repo text NOT NULL, target_branch text NOT NULL,
  submitted_head_sha text NOT NULL, assigned_base_sha text NOT NULL,
  candidate_sha text, candidate_ref text NOT NULL, policy jsonb NOT NULL,
  policy_digest text NOT NULL, status text NOT NULL, reason text,
  requested_by_id bigint NOT NULL, requested_by_login text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  landed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS candidates_one_active_pr ON candidates(repository_id, pr_number) WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS candidates_ref_unique ON candidates(repository_id, candidate_ref);
CREATE TABLE IF NOT EXISTS merge_commands (
  comment_id bigint PRIMARY KEY, repository_id bigint NOT NULL, pr_number integer NOT NULL,
  command text NOT NULL, actor_id bigint NOT NULL, actor_login text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  disposition text, error text
);
`;

export async function migrate(pool: Pool): Promise<void> { await pool.query(migration); }
export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await transactionOnClient(client, fn); } finally { client.release(); }
}
export async function transactionOnClient<T>(client: PoolClient, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
}
