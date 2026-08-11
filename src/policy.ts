import { z } from 'zod';

export const requiredCheckSchema = z.object({ name: z.string().min(1), appId: z.number().int().positive().optional() }).strict();
export const policySchema = z.object({
  maxChangedFiles: z.number().int().positive().default(100),
  maxAdditions: z.number().int().positive().default(5000),
  maxDeletions: z.number().int().positive().default(5000),
  requiredChecks: z.array(requiredCheckSchema).default([]),
  sensitivePaths: z.array(z.string().min(1)).default([]),
}).strict();
export type Policy = z.infer<typeof policySchema>;
export const defaultPolicy: Policy = policySchema.parse({});
