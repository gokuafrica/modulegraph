import type { Effect } from '../../schema/modulegraph.ts';

export function dedupeEffects(effects: Effect[]): Effect[] {
  const seen = new Map<string, Effect>();
  for (const e of effects) if (!seen.has(effectKey(e))) seen.set(effectKey(e), e);
  return [...seen.values()];
}

export function effectKey(e: Effect): string {
  return `${e.kind} ${e.target}`;
}
