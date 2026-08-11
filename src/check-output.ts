import type { Decision } from './evaluator.js';
export function checkOutput(decision: Decision) {
  const output = { title: decision.message, summary: `Decision: **${decision.outcome}**\n\nReason: \`${decision.code}\`` };
  return decision.outcome === 'waiting' ? { status: 'in_progress' as const, output } : { status: 'completed' as const, conclusion: decision.outcome === 'eligible' ? 'success' as const : 'action_required' as const, output };
}
