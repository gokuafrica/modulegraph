import { diffLines } from 'diff';
import type { CodeChange, DiffLine, Edge, Scope, Step } from '../../schema/modulegraph.ts';
import type { Part } from './extract.ts';

/** Every function of a snapshot by name: operations by op id ("KycModule.getStatus", as helpers name them), helpers by name. */
export function functionIndex(parts: Record<string, Part[]>): Map<string, Part> {
  const out = new Map<string, Part>();
  for (const [scopeId, list] of Object.entries(parts)) {
    list.forEach((p, i) => out.set(i === 0 && p.role === 'operation' ? scopeId : p.name, p));
  }
  return out;
}

/**
 * Per-function changes behind a scope: own function first, then helpers, matched by name across files.
 * A helper that is merely called now (or no longer) but whose code is unchanged is not a code change: the flow
 * shows it as an added/removed step instead.
 */
export function codeChanges(before: Part[] | undefined, after: Part[] | undefined, baseFns?: Map<string, Part>, headFns?: Map<string, Part>): CodeChange[] {
  const b = new Map((before ?? []).map((p) => [p.name, p]));
  const a = new Map((after ?? []).map((p) => [p.name, p]));
  const out: CodeChange[] = [];
  for (const [i, p] of (after ?? []).entries()) {
    const prev = b.get(p.name) ?? (i > 0 ? baseFns?.get(p.name) : undefined);
    if (prev && prev.text === p.text) continue;
    const diff = prev ? numberedDiff(prev.text, prev.line, p.text, p.line) : p.text.split('\n').map((text, i) => ({ t: '+' as const, text, b: p.line + i }));
    out.push(change(p, prev ? 'modified' : 'added', diff));
  }
  for (const [i, p] of (before ?? []).entries()) {
    if (a.has(p.name) || (i > 0 && headFns?.has(p.name))) continue;
    out.push(change(p, 'removed', p.text.split('\n').map((text, i) => ({ t: '-' as const, text, a: p.line + i }))));
  }
  return out;
}

function change(p: Part, status: CodeChange['status'], diff: DiffLine[]): CodeChange {
  return {
    name: p.name, role: p.role, file: p.file, line: p.line, status,
    added: diff.filter((l) => l.t === '+').length,
    removed: diff.filter((l) => l.t === '-').length,
    diff,
  };
}

export function numberedDiff(before: string, beforeLine: number, after: string, afterLine: number): DiffLine[] {
  let a = beforeLine;
  let b = afterLine;
  const out: DiffLine[] = [];
  for (const part of diffLines(before, after)) {
    for (const text of part.value.replace(/\n$/, '').split('\n')) {
      if (part.added) out.push({ t: '+', text, b: b++ });
      else if (part.removed) out.push({ t: '-', text, a: a++ });
      else out.push({ t: ' ', text, a: a++, b: b++ });
    }
  }
  return out;
}

const stepKey = (s: Step) => s.target ?? `${s.effect?.kind} ${s.effect?.target}`;

/** Marks steps the head added, records guards that changed, and keeps the base's removed steps as ghosts. */
export function diffScope(head: Scope, base: Scope): void {
  const pool = new Map<string, Step[]>();
  for (const s of base.steps) pool.set(stepKey(s), [...(pool.get(stepKey(s)) ?? []), s]);
  const matched = new Map<string, string>(); // base step id -> head step id
  for (const s of head.steps) {
    const prev = pool.get(stepKey(s))?.shift();
    if (!prev) {
      s.delta = 'added';
      continue;
    }
    matched.set(prev.id, s.id);
    if ((prev.condition ?? '') !== (s.condition ?? '')) s.conditionBefore = prev.condition ?? '';
  }
  const removed = base.steps.filter((s) => !matched.has(s.id));
  if (!removed.length) return;
  const map = (id: string) => (id === 'entry' || id === 'exit' ? id : matched.get(id) ?? `rm:${id}`);
  const removedIds = new Set(removed.map((s) => s.id));
  head.removedSteps = removed.map((s) => ({ ...s, id: `rm:${s.id}`, delta: 'removed' }));
  head.removedEdges = base.edges
    .filter((e: Edge) => removedIds.has(e.from) || removedIds.has(e.to))
    .map((e) => ({ ...e, from: map(e.from), to: map(e.to) }));
}
