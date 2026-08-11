import { z } from 'zod';

export const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_PRIVATE_KEY: z.string().min(1).transform((v) => v.replaceAll('\\n', '\n')),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DISPATCH_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),
});
export type Config = z.infer<typeof configSchema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => configSchema.parse(env);
