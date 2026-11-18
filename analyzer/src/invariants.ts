import type { AnalysisIssue, Effect, ModuleGraph } from '../../schema/modulegraph.ts';

/**
 * Properties every correct review has, checked on every review (not only in tests). No service's names in here.
 * A failure is an `invariant` item of `incomplete`, scoped to the operation or entry point it is about: the box
 * shows it, and the review says it can't be taken at face value there.
 *   I1 every effect names what it touches (a table, topic, event type, host or URL template), never code or "?"
 *   I2 one entry point per registered thing (a route, a job, a consumer key)
 *   I3 entry points have real labels
 *   I4 every effect step names its target
 *   I5 every HTTP route the framework declares is an entry point (the backend checks it: `issues()`)
 *   I7 every flagged package comes with a rule for it (a sink or `coverage.ignore`)
 *   I9 gaps are structured: file, line and a reason from the closed list
 */
export const RAW_TARGET = /^\?$|^$|[<>()`]|\{(get|getOrThrow|getOrDefault)\}|\bthis\.|\bparameters?\.|\bconfigService\b|undefined/;
const REASONS = new Set(['function-value', 'interface-dispatch', 'untyped', 'dynamic']);

export function invariantIssues(g: Pick<ModuleGraph, 'operations' | 'entryPoints' | 'scopes'> & { incomplete?: AnalysisIssue[] }): AnalysisIssue[] {
  const out: AnalysisIssue[] = [];
  const add = (scope: string, message: string, items: string[] = []) => out.push({ kind: 'invariant', scope, message, ...(items.length ? { items } : {}) });
  const raw = (fx: Effect[]) => [...new Set(fx.filter((f) => RAW_TARGET.test(f.target ?? '')).map((f) => `${f.kind} ${f.target}${f.file ? ` (${f.file}:${f.line})` : ''}`))];

  for (const op of Object.values(g.operations)) {
    if (op.change === 'removed') continue;
    const bad = raw([...op.directEffects, ...op.effects]);
    if (bad.length) add(op.id, `I1: ${op.id} has a side effect whose target is code, not a name: ${bad[0]}`, bad);
    const badGaps = (op.gaps ?? []).filter((x) => !x.file || !x.line || !REASONS.has(x.reason));
    if (badGaps.length) add(op.id, `I9: ${op.id} has a gap without a file, line or known reason`, badGaps.map((x) => JSON.stringify(x)));
  }
  const byKey = new Map<string, string[]>();
  for (const e of Object.values(g.entryPoints)) {
    if (e.change === 'removed') continue;
    const bad = raw(e.effects);
    if (bad.length) add(e.id, `I1: ${e.label} has a side effect whose target is code, not a name: ${bad[0]}`, bad);
    if (/\?|undefined|<[^>]*>/.test(e.label)) add(e.id, `I3: the entry point at ${e.file}:${e.line} has no real label ("${e.label}")`);
    const key = `${e.kind} ${e.label.replace(/\s*\([^)]*\)\s*$/, '')}`;
    byKey.set(key, [...(byKey.get(key) ?? []), e.id]);
  }
  for (const [key, ids] of byKey) if (ids.length > 1) for (const id of ids) add(id, `I2: ${key} is listed ${ids.length} times as an entry point: ${ids.join(', ')}`);
  for (const [id, scope] of Object.entries(g.scopes)) {
    const bad = scope.steps.filter((s) => s.kind === 'effect' && (!s.effect || RAW_TARGET.test(s.effect.target ?? '')));
    if (bad.length) add(id, `I4: a step of ${id} names no target (${bad[0].file}:${bad[0].line})`, bad.map((s) => `${s.effect ? `${s.effect.kind} ${s.effect.target}` : 'no effect'} (${s.file}:${s.line})`));
  }
  for (const i of g.incomplete ?? []) {
    if (i.kind !== 'unknown-side-effects') continue;
    for (const item of i.items ?? []) {
      const pkg = /^(@?[^\s(:]+)/.exec(item)?.[1];
      if (pkg && !(i.suggestion ?? '').includes(`"${pkg}"`)) add(pkg, `I7: ${pkg} is flagged, but no rule for it is suggested`);
    }
  }
  return out;
}

/** The graph's `incomplete` with this review's invariant failures in it (replacing those of an earlier pass). */
export function withInvariants<G extends Pick<ModuleGraph, 'operations' | 'entryPoints' | 'scopes'> & { incomplete?: AnalysisIssue[] }>(g: G): G {
  const rest = (g.incomplete ?? []).filter((i) => i.kind !== 'invariant' || !i.message.match(/^I[12349]:/));
  const all = [...rest, ...invariantIssues({ ...g, incomplete: rest })];
  if (all.length) g.incomplete = all;
  else delete g.incomplete;
  return g;
}
