import type { Policy } from './policy.js';

export type Outcome = 'eligible' | 'waiting' | 'author_action' | 'human_review';
export interface Facts { draft: boolean; fork: boolean; mergeable: boolean | null; files: string[]; additions: number; deletions: number; reviews: { state: string }[]; checks: { name: string; appId?: number; status: string; conclusion?: string | null }[] }
export interface Decision { outcome: Outcome; code: string; message: string }
const sensitiveRoots = ['.merge-manager/', '.github/workflows/', '.agents/'];
const result = (outcome: Outcome, code: string, message: string): Decision => ({ outcome, code, message });
export function evaluate(f: Facts, p: Policy): Decision {
  if (f.fork) return result('human_review', 'fork', 'Fork pull requests require human review.');
  if (f.files.some((file) => [...sensitiveRoots, ...p.sensitivePaths].some((prefix) => file === prefix.replace(/\/$/, '') || file.startsWith(prefix)))) return result('human_review', 'sensitive_files', 'Sensitive files require human review.');
  if (f.files.length > p.maxChangedFiles || f.additions > p.maxAdditions || f.deletions > p.maxDeletions) return result('author_action', 'oversized', 'Pull request exceeds configured size limits.');
  if (f.reviews.some((r) => r.state.toUpperCase() === 'CHANGES_REQUESTED')) return result('author_action', 'changes_requested', 'A review requests changes.');
  if (f.mergeable === false) return result('author_action', 'merge_conflict', 'Pull request has merge conflicts.');
  if (f.draft) return result('waiting', 'draft', 'Pull request is a draft.');
  if (f.mergeable === null) return result('waiting', 'mergeability_unknown', 'GitHub has not determined mergeability.');
  for (const required of p.requiredChecks) {
    const matches = f.checks.filter((c) => c.name === required.name && (required.appId === undefined || c.appId === required.appId));
    if (matches.length !== 1) return result('waiting', matches.length ? 'ambiguous_required_check' : 'missing_required_check', `Required check ${required.name} is not uniquely available.`);
    const check = matches[0]!;
    if (check.status !== 'completed') return result('waiting', 'pending_required_check', `Required check ${required.name} is pending.`);
    if (check.conclusion !== 'success') return result('author_action', 'required_check_failed', `Required check ${required.name} did not pass.`);
  }
  return result('eligible', 'all_gates_pass', 'All configured observer gates pass.');
}
