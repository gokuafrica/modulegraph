import { diffLines } from 'diff';
import type { ContractDelta, DiffLine, Effect, EntryPoint, Operation, Param, PipelineItem, Risk, TypeShape } from '../../schema/modulegraph.ts';
import { codeChanges, diffScope, functionIndex } from './compare-steps.ts';
import { effectKey } from './effects.ts';
import type { Part, Snapshot } from './analyzers/types.ts';

export type Graphish = Omit<Snapshot, 'fingerprints' | 'parts'>;

/** Folds the base snapshot into the head one: change status, contract deltas and per-op line diffs. */
export function compare(head: Snapshot, base?: Snapshot): Graphish {
  const out: Graphish = structuredClone({
    modules: head.modules,
    operations: head.operations,
    entryPoints: head.entryPoints,
    scopes: head.scopes,
  });
  if (!base) return out;
  const baseFns = functionIndex(base.parts);
  const headFns = functionIndex(head.parts);

  for (const op of Object.values(out.operations)) {
    const before = base.operations[op.id];
    if (!before) {
      op.change = 'added';
      op.diff = op.source.split('\n').map((text) => ({ t: '+', text }));
    } else if (base.fingerprints[op.id] !== head.fingerprints[op.id]) {
      op.change = 'modified';
      op.diff = lineDiff(before.source, op.source);
      op.changes = codeChanges(base.parts[op.id], head.parts[op.id], baseFns, headFns);
      if (base.scopes[op.id] && out.scopes[op.id]) diffScope(out.scopes[op.id], base.scopes[op.id]);
    } else if (keys(before.calls) !== keys(op.calls) || keys(before.directEffects.map(effectKey)) !== keys(op.directEffects.map(effectKey))) {
      // Same code, different wiring: a DI binding or an entity's table moved, so its calls or effects go elsewhere.
      op.change = 'modified';
      op.diff = lineDiff(before.source, op.source);
      op.changes = [];
      if (base.scopes[op.id] && out.scopes[op.id]) diffScope(out.scopes[op.id], base.scopes[op.id]);
    }
    if (op.change === 'added') op.changes = codeChanges(undefined, head.parts[op.id], baseFns, headFns);
    const delta = contractDelta(before, op);
    if (delta.risk !== 'none') op.delta = delta;
  }
  for (const before of Object.values(base.operations)) {
    if (out.operations[before.id]) continue;
    out.operations[before.id] = {
      ...structuredClone(before),
      change: 'removed',
      diff: before.source.split('\n').map((text) => ({ t: '-', text })),
      delta: contractDelta(before, undefined),
    };
    out.scopes[before.id] ??= structuredClone(base.scopes[before.id]);
  }

  for (const mod of Object.values(out.modules)) {
    if (!base.modules[mod.id]) mod.change = 'added';
    else if (base.fingerprints[`module:${mod.id}`] !== head.fingerprints[`module:${mod.id}`]) mod.change = 'modified';
  }
  for (const before of Object.values(base.modules)) {
    if (out.modules[before.id]) continue;
    out.modules[before.id] = { ...structuredClone(before), change: 'removed' };
  }

  for (const entry of Object.values(out.entryPoints)) {
    const before = base.entryPoints[entry.id];
    if (!before) entry.change = 'added';
    else if (base.fingerprints[entry.id] !== head.fingerprints[entry.id]) {
      entry.change = 'modified';
      entry.changes = codeChanges(base.parts[entry.id], head.parts[entry.id], baseFns, headFns);
      if (base.scopes[entry.id] && out.scopes[entry.id]) diffScope(out.scopes[entry.id], base.scopes[entry.id]);
    }
    if (entry.change === 'added') entry.changes = codeChanges(undefined, head.parts[entry.id], baseFns, headFns);
    if (before) {
      const delta = pipelineDelta(before.pipeline ?? [], entry.pipeline ?? [], base.parts[entry.id] ?? [], head.parts[entry.id] ?? []);
      if (delta) {
        entry.pipelineDelta = delta;
        // Who may call it, or what runs around it, changed: the entry point changed even if its handler didn't.
        if (entry.change === 'unchanged') entry.change = 'modified';
      }
    }
    const prev = before?.effects ?? [];
    entry.effectsAdded = entry.effects.filter((e) => !prev.some((p) => effectKey(p) === effectKey(e)));
    entry.effectsRemoved = prev.filter((p) => !entry.effects.some((e) => effectKey(p) === effectKey(e)));
  }
  for (const before of Object.values(base.entryPoints)) {
    if (out.entryPoints[before.id]) continue;
    out.entryPoints[before.id] = { ...structuredClone(before), change: 'removed' };
    out.scopes[before.id] ??= structuredClone(base.scopes[before.id]);
  }

  markContainsChanges(out);
  return out;
}

/** `guard AuthGuard (global)`: how a pipeline item is compared between revisions. */
export function pipelineKey(p: PipelineItem): string {
  return `${p.kind} ${p.name} (${p.scope})`;
}

/**
 * Pipeline items an entry point gained or lost, and those whose code changed (a guard's `canActivate` or a helper it
 * calls, compared by the functions the head or base analysis recorded for it).
 */
function pipelineDelta(before: PipelineItem[], after: PipelineItem[], baseParts: Part[], headParts: Part[]): EntryPoint['pipelineDelta'] {
  const b = new Map(before.map((p) => [pipelineKey(p), p]));
  const a = new Map(after.map((p) => [pipelineKey(p), p]));
  const text = (parts: Part[], name: string) => parts.find((p) => p.name === name)?.text;
  const added = [...a.keys()].filter((k) => !b.has(k));
  const removed = [...b.keys()].filter((k) => !a.has(k));
  const changed = [...a].filter(([k, p]) => b.has(k) && [...new Set([...(p.functions ?? []), ...(b.get(k)!.functions ?? [])])].some((fn) => text(baseParts, fn) !== text(headParts, fn))).map(([k]) => k);
  return added.length || removed.length || changed.length ? { added, removed, changed } : undefined;
}

function markContainsChanges(g: Graphish): void {
  const memo = new Map<string, boolean>();
  const visit = (opId: string, stack: Set<string>): boolean => {
    if (memo.has(opId)) return memo.get(opId)!;
    const op = g.operations[opId];
    if (!op || stack.has(opId)) return false;
    stack.add(opId);
    const changed = op.change !== 'unchanged' || op.calls.some((c) => visit(c, stack));
    stack.delete(opId);
    memo.set(opId, changed);
    return changed;
  };
  for (const op of Object.values(g.operations)) op.containsChanges = visit(op.id, new Set());
  for (const entry of Object.values(g.entryPoints)) {
    const steps = g.scopes[entry.id]?.steps ?? [];
    entry.containsChanges = entry.change !== 'unchanged' || steps.some((s) => !!s.target && visit(s.target, new Set()));
  }
}

export function contractDelta(before: Operation | undefined, after: Operation | undefined): ContractDelta {
  const b = before?.effects ?? [];
  const a = after?.effects ?? [];
  const effectsAdded = a.filter((e) => !b.some((x) => effectKey(x) === effectKey(e)));
  const effectsRemoved = b.filter((e) => !a.some((x) => effectKey(x) === effectKey(e)));
  const callsAdded = (after?.calls ?? []).filter((c) => !(before?.calls ?? []).includes(c));
  const callsRemoved = (before?.calls ?? []).filter((c) => !(after?.calls ?? []).includes(c));
  const paramsChanged = !!before && !!after && paramSig(before.params) !== paramSig(after.params);
  const returnsChanged = !!before && !!after && shapeSig(before.returns) !== shapeSig(after.returns);
  const bodyChanged = !before || !after || before.source !== after.source;

  const writes = (es: Effect[]) => es.some((e) => e.kind !== 'db.read');
  let risk: Risk = 'none';
  if (writes(effectsAdded) || writes(effectsRemoved) || paramsChanged || !before || !after) risk = 'high';
  else if (effectsAdded.length || effectsRemoved.length || returnsChanged || callsAdded.length || callsRemoved.length) risk = 'medium';
  else if (bodyChanged) risk = 'low';

  return {
    risk,
    ...(paramsChanged ? { params: { before: before!.params, after: after!.params } } : {}),
    ...(returnsChanged ? { returns: { before: before!.returns, after: after!.returns } } : {}),
    effectsAdded,
    effectsRemoved,
    callsAdded,
    callsRemoved,
    implementationOnly: risk === 'low',
  };
}

function lineDiff(before: string, after: string): DiffLine[] {
  return diffLines(before, after).flatMap((part) =>
    part.value
      .replace(/\n$/, '')
      .split('\n')
      .map((text) => ({ t: part.added ? '+' : part.removed ? '-' : ' ', text }) as DiffLine),
  );
}

const paramSig = (ps: Param[]) => ps.map((p) => `${p.name}:${p.type}`).join(',');
const shapeSig = (s: TypeShape) => `${s.type}|${(s.fields ?? []).map((f) => `${f.name}:${f.type}`).join(',')}`;

/** A list as a set, for comparing calls and effects regardless of order. */
const keys = (xs: string[]) => [...new Set(xs)].sort().join('|');
