import { diffLines } from 'diff';
import type { ContractDelta, DiffLine, Effect, Operation, Param, Risk, TypeShape } from '../../schema/modulegraph.ts';
import { codeChanges, diffScope, functionIndex } from './compare-steps.ts';
import { effectKey } from './effects.ts';
import type { Snapshot } from './analyzers/types.ts';

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
  // Same parameters first, then only optional ones: every existing call still compiles and means the same.
  const compatible = paramsChanged && before!.params.length < after!.params.length &&
    before!.params.every((p, i) => p.type === after!.params[i].type && !!p.optional === !!after!.params[i].optional) &&
    after!.params.slice(before!.params.length).every((p) => p.optional);
  const returnsChanged = !!before && !!after && shapeSig(before.returns) !== shapeSig(after.returns);
  const bodyChanged = !before || !after || before.source !== after.source;

  const writes = (es: Effect[]) => es.some((e) => e.kind !== 'db.read');
  let risk: Risk = 'none';
  if (writes(effectsAdded) || writes(effectsRemoved) || (paramsChanged && !compatible) || !before || !after) risk = 'high';
  else if (effectsAdded.length || effectsRemoved.length || returnsChanged || callsAdded.length || callsRemoved.length) risk = 'medium';
  else if (bodyChanged) risk = 'low';

  return {
    risk,
    ...(paramsChanged ? { params: { before: before!.params, after: after!.params, ...(compatible ? { compatible } : {}) } } : {}),
    ...(returnsChanged ? { returns: { before: before!.returns, after: after!.returns } } : {}),
    effectsAdded,
    effectsRemoved,
    callsAdded,
    callsRemoved,
    implementationOnly: risk === 'low' && !paramsChanged,
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
