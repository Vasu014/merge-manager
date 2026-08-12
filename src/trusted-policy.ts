import type { Policy } from './policy.js';
import { defaultPolicy, policySchema } from './policy.js';

type ContentReader = {
  rest: {
    repos: {
      getContent(input: { owner: string; repo: string; path: string; ref: string }): Promise<{ data: unknown }>;
    };
  };
};

export type TrustedPolicyResult =
  | { valid: true; policy: Policy; evidence: unknown }
  | { valid: false; policy: Policy; evidence: { invalid: true; baseSha: string } };

export async function loadTrustedPolicy(
  octokit: ContentReader,
  repository: { owner: string; repo: string },
  baseSha: string,
): Promise<TrustedPolicyResult> {
  try {
    const response = await octokit.rest.repos.getContent({ ...repository, path: '.merge-manager/policy.json', ref: baseSha });
    const data = response.data as { type?: string; encoding?: string; content?: string } | unknown[];
    if (Array.isArray(data) || data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') {
      throw new Error('Policy must be a Base64-encoded file.');
    }
    const raw = Buffer.from(data.content, 'base64').toString('utf8');
    return { valid: true, policy: policySchema.parse(JSON.parse(raw)), evidence: raw };
  } catch (error: any) {
    if (error?.status === 404) return { valid: true, policy: defaultPolicy, evidence: defaultPolicy };
    if (error?.status) throw error;
    return { valid: false, policy: defaultPolicy, evidence: { invalid: true, baseSha } };
  }
}
