import type { Effect, EntryPoint, Exit, ModuleGraph, Operation, Param, Scope, Step } from '../../../schema/modulegraph.ts';

export type NodeKind = 'module' | 'effect' | 'entry' | 'exit' | 'resource' | 'entrygroup' | 'code' | 'decision' | 'stop' | 'frontier';
export type EdgeKind = 'data' | 'control' | 'call' | 'read' | 'write' | 'branch' | 'removed';

export interface VNode {
  id: string;
  type: NodeKind;
  width: number;
  height: number;
  data: Record<string, unknown>;
}

export interface VEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
  highlight?: boolean;
}

export interface Model {
  nodes: VNode[];
  edges: VEdge[];
}

export interface Chip {
  kind: Effect['kind'];
  target: string;
  direct: boolean;
  delta?: '+' | '-';
}

export const effectKey = (e: Effect) => `${e.kind} ${e.target}`;

export function opTitle(g: ModuleGraph, opId: string): string {
  if (opId.startsWith(MODULE_TARGET)) {
    const id = opId.slice(MODULE_TARGET.length);
    return `${g.modules[id]?.name ?? id} (all operations)`;
  }
  const op = g.operations[opId];
  return op ? `${g.modules[op.moduleId]?.name ?? op.moduleId}.${op.name}` : opId;
}

/** Impact views can start at a whole module ("module:<id>"): the references to any of its operations. */
export const MODULE_TARGET = 'module:';

/** The operations an impact view starts at: the one operation, or every operation of the module. */
export function targetOps(g: ModuleGraph, target: string): string[] {
  if (!target.startsWith(MODULE_TARGET)) return [target];
  const id = target.slice(MODULE_TARGET.length);
  return Object.values(g.operations).filter((o) => o.moduleId === id && o.change !== 'removed').map((o) => o.id);
}

/** Effect chips for an operation: transitive effects, direct ones solid, plus +/− contract delta. */
export function chipsFor(op: Operation): Chip[] {
  const added = new Set(op.delta?.effectsAdded.map(effectKey));
  const direct = new Set(op.directEffects.map(effectKey));
  const chips: Chip[] = op.effects.map((e) => ({ kind: e.kind, target: e.target, direct: direct.has(effectKey(e)), delta: added.has(effectKey(e)) ? '+' : undefined }));
  for (const e of op.delta?.effectsRemoved ?? []) chips.push({ kind: e.kind, target: e.target, direct: false, delta: '-' });
  const order = (c: Chip) => (c.delta ? 0 : c.direct ? 1 : 2);
  return chips.sort((a, b) => order(a) - order(b));
}

/** An operation's side effects as they were on the base revision (for the "before" view). */
export function chipsBefore(op: Operation): Chip[] {
  const direct = new Set(op.directEffects.map(effectKey));
  if (op.change === 'removed') return op.effects.map((e) => ({ kind: e.kind, target: e.target, direct: direct.has(effectKey(e)) }));
  const added = new Set(op.delta?.effectsAdded.map(effectKey));
  const effects = [...op.effects.filter((e) => !added.has(effectKey(e))), ...(op.delta?.effectsRemoved ?? [])];
  return [...new Map(effects.map((e) => [effectKey(e), { kind: e.kind, target: e.target, direct: direct.has(effectKey(e)) }])).values()]
    .sort((a, b) => Number(b.direct) - Number(a.direct));
}

/** The scope's flow on the base revision: what the "before" view draws. Unchanged flows are their own before. */
function scopeBefore(raw: Scope): Scope & { addedCount: number } {
  const now = new Map(raw.steps.map((s) => [s.id, s]));
  const steps = (raw.before?.steps ?? raw.steps).map((s) => {
    const head = now.get(s.id);
    // Mark what this change does to the step: removes it, or guards it differently.
    const mark = s.delta === 'removed' ? { beforeMark: 'removed' } : head?.conditionBefore !== undefined ? { beforeMark: 'guard', conditionNow: head.condition ?? '' } : {};
    return { ...s, delta: undefined, conditionBefore: undefined, ...mark } as Step;
  });
  return {
    ...raw,
    steps,
    edges: raw.before?.edges ?? raw.edges,
    returns: raw.before ? raw.before.returns : raw.returns,
    exits: raw.before ? raw.before.exits : raw.exits,
    removedSteps: undefined,
    removedEdges: undefined,
    addedCount: raw.steps.filter((s) => s.delta === 'added').length + (raw.exits ?? []).filter((x) => x.delta).length,
  };
}

function moduleNode(g: ModuleGraph, id: string, opId: string, extra: Record<string, unknown> = {}): VNode {
  const op = g.operations[opId];
  // Lazy graphs can reference operations that are not analyzed yet: name them from their class.
  const mod = op ? g.modules[op.moduleId] : Object.values(g.modules).find((m) => m.className === opId.split('.')[0]);
  const all = (extra.chipsOverride as Chip[] | undefined) ?? (op ? chipsFor(op) : []);
  // Compact (zoom-out) nodes only show what the change did to their effects; the full list is in the inspector.
  const chips = extra.compact && !extra.focus ? all.filter((c) => c.delta) : all;
  const shown = Math.min(chips.length, 6);
  // One effect per row with its full table / topic / event name; long names wrap onto a second line.
  const chipLines = chips.slice(0, 6).reduce((n, c) => n + Math.ceil((c.target.length + 10) / 34), 0);
  const opsLines = Array.isArray(extra.ops) ? Math.ceil((extra.ops as string[]).length / 2) : 0;
  const deltaLine = extra.delta || extra.beforeMark === 'removed' ? 18 : 0;
  const uses = extra.compact ? [] : usesOf(g, opId);
  const height = (extra.compact ? 56 : 62) + chipLines * 19 + shown * 5 + (chips.length > 6 ? 22 : 0) + (extra.condition ? 20 : 0) + (extra.via ? 16 : 0) + (extra.through ? 16 : 0) + (extra.transaction ? 18 : 0) + (uses.length ? 18 : 0) + opsLines * 16 + deltaLine;
  return {
    id,
    type: 'module',
    width: 270,
    height,
    data: {
      opId,
      title: mod?.name ?? opId.split('.')[0],
      operation: op?.name ?? opId.split('.')[1],
      change: op?.change ?? 'unchanged',
      moduleChange: mod?.change,
      containsChanges: op?.containsChanges ?? false,
      chips,
      uses,
      totalEffects: all.length,
      hasInternals: (g.scopes[opId]?.steps.length ?? 0) > 0,
      hasDiff: !!op?.changes?.length,
      stub: !op,
      partial: !!g.lazy && !!op && !op.lazy?.calleesLoaded,
      reachPartial: !!g.lazy && !!op && !op.lazy?.callersLoaded,
      ...extra,
      chipsOverride: undefined,
    },
  };
}

/** Other modules an operation calls directly (its sub-modules), in call order. */
export function usesOf(g: ModuleGraph, opId: string): { opId: string; module: string; changed: boolean }[] {
  const op = g.operations[opId];
  const out = new Map<string, { opId: string; module: string; changed: boolean }>();
  for (const step of g.scopes[opId]?.steps ?? []) {
    if (step.kind !== 'call' || !step.target) continue;
    const callee = g.operations[step.target];
    const moduleId = callee?.moduleId ?? step.target.split('.')[0];
    if (op && moduleId === op.moduleId) continue;
    const name = g.modules[moduleId]?.name ?? moduleId;
    const changed = !!callee && (callee.change !== 'unchanged' || callee.containsChanges) || step.delta === 'added';
    const prev = out.get(name);
    out.set(name, { opId: prev?.opId ?? step.target, module: name, changed: (prev?.changed ?? false) || changed });
  }
  return [...out.values()];
}

/**
 * A call to an operation that only forwards to another operation of the same module (`cancel(id)` → `this.cancelWith(id, …)`)
 * shows the operation doing the work, with the wrapper named. Wrappers across modules stay: they are module boundaries.
 */
function skipWrappers(g: ModuleGraph, target: string): { target: string; through: string[] } {
  const through: string[] = [];
  let cur = target;
  for (;;) {
    const steps = g.scopes[cur]?.steps ?? [];
    const next = steps.length === 1 && steps[0].kind === 'call' ? steps[0].target : undefined;
    if (!next || through.includes(next) || next === target || !g.scopes[next]?.steps.length) break;
    if (g.operations[next]?.moduleId !== g.operations[cur]?.moduleId) break;
    through.push(opTitle(g, cur));
    cur = next;
  }
  return { target: cur, through };
}

function entryNode(g: ModuleGraph, entry: EntryPoint, id = `entry:${entry.id}`, extra: Record<string, unknown> = {}): VNode {
  const params = g.scopes[entry.id]?.params ?? [];
  return {
    id,
    type: 'entry',
    width: 250,
    height: 70 + (entry.effectsAdded?.length ? 22 : 0) + (extra.via ? 18 : 0) + (extra.compact && entry.analysis === 'reached' ? 16 : 0),
    data: { entryId: entry.id, kind: entry.kind, label: entry.label, change: entry.change, containsChanges: entry.containsChanges, readOnly: entry.readOnly, effectsAdded: entry.effectsAdded ?? [], params, analysis: entry.analysis, ...extra },
  };
}

const exitLabel: Record<EntryPoint['kind'], string> = { api: 'HTTP response', grpc: 'gRPC reply', consumer: 'commit offset', cron: 'job finished', queue: 'job done', event: 'listener done' };

function fieldsWithDelta(after: Param[] | undefined, before: Param[] | undefined) {
  const prev = new Set((before ?? []).map((f) => f.name));
  const next = new Set((after ?? []).map((f) => f.name));
  return [
    ...(after ?? []).map((f) => ({ ...f, delta: before && !prev.has(f.name) ? '+' : undefined })),
    ...(before ?? []).filter((f) => !next.has(f.name)).map((f) => ({ ...f, delta: '-' })),
  ];
}

export interface FlowOptions {
  collapsePassthrough: boolean;
  showResources: boolean;
  focusOp?: string;
  focusPath?: Set<string>;
  /** Draw the flow as it was on the base revision. */
  before?: boolean;
}

/**
 * Entry → modules → exit for one scope (entry point or operation). The scope itself is never replaced by what it
 * calls: opening an endpoint shows the controller handing the request to its module(s), and drilling into a module
 * shows its sub-modules and its own side effects. That keeps every level module-sized, however complex the API.
 */
export function flowModel(g: ModuleGraph, scopeId: string, opts: FlowOptions): Model & { chain: string[]; addedCount?: number } {
  const chain = [scopeId];
  const current = g.scopes[scopeId];
  const was = opts.before && current ? scopeBefore(current) : undefined;
  const raw = was ?? current;
  const before = !!was;
  const scope = raw && opts.collapsePassthrough
    ? {
        ...raw,
        steps: raw.steps.map((s) => {
          if (s.kind !== 'call' || !s.target) return s;
          const { target, through } = skipWrappers(g, s.target);
          return through.length ? { ...s, target, through: through.join(' › ') } : s;
        }),
      }
    : raw;
  const nodes: VNode[] = [];
  const edges: VEdge[] = [];
  if (!scope) return { nodes, edges, chain };
  const via = chain.slice(1).map((id) => opTitle(g, id));
  const rootEntry = g.entryPoints[scopeId];
  const innerOp = g.operations[chain.at(-1)!];
  // An entry point that hands the request to one module answers with that module's result: its recorded calls and
  // output delta belong on the input and the response.
  const handedTo = rootEntry && scope.steps.length === 1 && scope.steps[0].kind === 'call' ? g.operations[scope.steps[0].target!] : undefined;
  const contractOp = innerOp ?? handedTo;

  // Recorded examples are from the head revision: the "before" view shows them only where nothing changed.
  const examples = before && !untouched(contractOp) ? undefined : contractOp?.examples;
  const exampleParams = contractOp && examples?.length ? contractOp.params.map((p) => p.name) : [];
  if (rootEntry) {
    const node = entryNode(g, rootEntry, '__entry', { via: via.join(' › ') || undefined, examples, exampleParams });
    node.height += exampleParams.length ? 38 + exampleParams.length * 16 : 0;
    nodes.push(node);
  } else {
    nodes.push({
      id: '__entry',
      type: 'entry',
      width: 260,
      height: 50 + scope.params.length * 18 + (exampleParams.length ? 38 + exampleParams.length * 16 : 0),
      data: { kind: 'input', label: `${opTitle(g, chain.at(-1)!)}(…)`, params: before && innerOp?.delta?.params ? innerOp.delta.params.before : scope.params, change: 'unchanged', paramsDelta: before ? undefined : innerOp?.delta?.params, examples, exampleParams },
    });
  }

  // Steps guarded by `if (x)` / `unless (x)` hang off one decision node per condition, so exclusive
  // branches read as yes/no instead of two parallel arrows.
  const branchOf = new Map<string, { dec: string; branch: 'yes' | 'no' }>();
  const decisions = new Map<string, string>();
  const decide = (condition: string | undefined) => {
    const m = /^(if|unless) \((.+)\)$/.exec(condition ?? '');
    if (!m || condition!.includes(') and ')) return undefined;
    // `if (!x)` is the "no" branch of `x?`: one decision per test, not one per spelling
    const negated = /^!\s*([\w.$]+|\(.*\))$/.exec(m[2]);
    const test = negated ? negated[1].replace(/^\((.*)\)$/, '$1') : m[2];
    const yes = (m[1] === 'if') !== !!negated;
    if (!decisions.has(test)) decisions.set(test, `__dec${decisions.size}`);
    return { dec: decisions.get(test)!, branch: (yes ? 'yes' : 'no') as 'yes' | 'no' };
  };
  for (const step of scope.steps) {
    const b = decide(step.condition);
    if (b) branchOf.set(step.id, b);
  }
  // An early `throw` / `return` is the other side of the guard the later steps run under: `check.ok?` no → throws.
  const stops: { id: string; dec: string; branch: 'yes' | 'no'; exit: Exit }[] = [];
  (scope.exits ?? []).forEach((exit, i) => {
    const b = decide(exit.guard);
    if (b) stops.push({ id: `__stop${i}`, dec: b.dec, branch: b.branch === 'yes' ? 'no' : 'yes', exit });
  });
  for (const [cond, id] of decisions) {
    const added = stops.some((x) => x.dec === id && x.exit.delta === 'added');
    nodes.push({ id, type: 'decision', width: Math.max(added ? 190 : 130, cond.length * 7.5 + 40), height: added ? 58 : 46, data: { label: `${cond}?`, added } });
  }
  for (const { id, exit } of stops) {
    // The HTTP status the recorded requests got from this exception, when one of them was rejected by it.
    const status = exit.kind === 'throw' && exit.what ? contractOp?.examples?.find((e) => e.status && e.error?.includes(exit.what!))?.status : undefined;
    const lines = 1 + (exit.message ? Math.ceil((exit.message.length + 2) / 34) : 0);
    nodes.push({
      id, type: 'stop', width: 260, height: 44 + lines * 16 + (exit.delta ? 18 : 0),
      data: { exit, status, examples: examples },
    });
  }
  for (const step of scope.steps) {
    nodes.push(stepNode(g, branchOf.has(step.id) ? { ...step, condition: undefined } : step, opts.focusOp, opts.focusPath, false, before));
  }
  // Steps the base had and the head dropped stay visible as ghosts, so a removed call is as easy to spot as an added one.
  for (const step of scope.removedSteps ?? []) nodes.push(stepNode(g, step, undefined, undefined, true));
  if (scope.steps.length === 0 && innerOp) {
    // Before: the base revision's code, read back from the line diff.
    const source = before && innerOp.diff?.length ? innerOp.diff.filter((l) => l.t !== '+').map((l) => l.text).join('\n') : innerOp.source;
    const lines = source.split('\n').length;
    const changes = before ? [] : innerOp.changes ?? [];
    const diffLines = changes.reduce((n, c) => n + c.diff.reduce((k, l) => k + Math.max(1, Math.ceil(l.text.length / 62)), 0) + 2, 0);
    const height = changes.length ? Math.min(56 + diffLines * 16, 460) : Math.min(60 + lines * 15, 340);
    nodes.push({ id: '__code', type: 'code', width: changes.length ? 560 : 440, height, data: { opId: innerOp.id, source, changes, before } });
    edges.push({ id: 'e:in-code', source: '__entry', target: '__code', kind: 'control' }, { id: 'e:code-out', source: '__code', target: '__exit', kind: 'control' });
  }

  const returns = before && contractOp?.delta?.returns ? contractOp.delta.returns.before : scope.returns;
  const returnsBefore = contractOp?.delta?.returns?.before.fields;
  const exampleKeys = Math.max(0, ...(examples ?? []).map((e) => exampleKeyCount(e.output ?? e.error)));
  nodes.push({
    id: '__exit',
    type: 'exit',
    width: examples?.length ? 300 : 230,
    height: 46 + Math.min(returns?.fields?.length ?? 1, 8) * 18 + (examples?.length ? 24 + Math.min(exampleKeys, 9) * 16 : 0),
    data: {
      examples,
      label: rootEntry ? exitLabel[rootEntry.kind] : 'returns',
      type: returns?.type ?? 'void',
      fields: fieldsWithDelta(returns?.fields, contractOp?.delta?.returns && !before ? returnsBefore : undefined),
    },
  });

  const mapId = (id: string) => (id === 'entry' ? '__entry' : id === 'exit' ? '__exit' : id);
  for (const e of scope.edges) {
    const branch = branchOf.get(e.to);
    if (branch && e.kind === 'control') {
      // the guard's inputs feed the decision, not the guarded step
      edges.push({ id: `e:${e.from}-${branch.dec}`, source: mapId(e.from), target: branch.dec, kind: 'control' });
      continue;
    }
    edges.push({ id: `e:${e.from}-${e.to}`, source: mapId(e.from), target: mapId(e.to), kind: e.kind, label: e.label });
  }
  for (const e of scope.removedEdges ?? []) {
    edges.push({ id: `e:${e.from}-${e.to}`, source: mapId(e.from), target: mapId(e.to), kind: 'removed', label: e.label });
  }
  for (const id of decisions.values()) {
    if (!edges.some((e) => e.target === id)) edges.push({ id: `e:entry-${id}`, source: '__entry', target: id, kind: 'control' });
  }
  for (const [stepId, { dec, branch }] of branchOf) {
    edges.push({ id: `e:${dec}-${stepId}`, source: dec, target: stepId, kind: 'branch', label: branch });
  }
  for (const { id, dec, branch } of stops) edges.push({ id: `e:${dec}-${id}`, source: dec, target: id, kind: 'branch', label: branch });

  // What a reviewer asks of a publish next to a DB write: are they in one transaction, and who listens?
  const writes = scope.steps.flatMap((s) => {
    const fx = s.effect ? [s.effect] : s.target ? g.operations[s.target]?.effects ?? [] : [];
    return fx.filter((e) => e.kind === 'db.write').map((e) => ({ step: s, table: e.target }));
  });
  for (const node of nodes) {
    const step = node.type === 'effect' ? scope.steps.find((s) => s.id === node.id) : undefined;
    if (!step?.effect || !['event', 'kafka', 'queue', 'outbox'].includes(step.effect.kind)) continue;
    const notes: string[] = [];
    if (step.effect.kind === 'event') {
      const listeners = Object.values(g.entryPoints).filter((e) => e.kind === 'event' && e.label.includes(step.effect!.target));
      notes.push(listeners.length ? `handled by ${listeners.map((e) => e.label).join(', ')}` : 'no listener for it in this service');
    }
    const w = writes.find((x) => x.step.id !== step.id);
    if (w && step.effect.kind !== 'outbox') {
      const order = scope.steps.indexOf(w.step) < scope.steps.indexOf(step) ? 'after' : 'before';
      notes.push(
        w.step.transaction && w.step.transaction === step.transaction ? `same transaction as the ${w.table} write (${step.transaction})`
          : step.transaction ? `in ${step.transaction}; the ${w.table} write is not`
          : w.step.transaction ? `outside the ${w.table} write's transaction, ${order} it`
          : `${order} the ${w.table} write, no transaction around both`,
      );
    }
    node.data = { ...node.data, notes };
    node.height += notes.reduce((n, t) => n + Math.ceil(t.length / 36), 0) * 15 + 6;
  }

  const reduced = reduceEdges(edges, new Set(nodes.filter((n) => n.type === 'effect' || n.type === 'decision' || n.type === 'stop').map((n) => n.id)));
  edges.length = 0;
  edges.push(...reduced);

  if (opts.showResources) {
    const seen = new Set<string>();
    for (const step of scope.steps) {
      const effects = step.effect ? [step.effect] : step.target ? g.operations[step.target]?.effects ?? [] : [];
      for (const effect of effects) {
        const resId = resourceId(effect);
        if (!seen.has(resId)) {
          seen.add(resId);
          nodes.push({ id: resId, type: 'resource', width: 200, height: 44, data: { kind: resourceKind(effect), target: effect.target } });
        }
        edges.push({ id: `r:${step.id}-${effectKey(effect)}`, source: step.id, target: resId, kind: effect.kind === 'db.read' ? 'read' : 'write', label: verb(effect) });
      }
    }
  }
  return { nodes, edges: [...new Map(edges.map((e) => [e.id, e])).values()], chain, addedCount: was?.addedCount };
}

/**
 * Transitive reduction where it only adds noise: an edge out of the input, or into the exit, a side effect or a
 * decision, is dropped when another path already connects the same two nodes (e.g. `result` built from five steps
 * doesn't need five arrows into the write that stores it). Module-to-module data edges are kept: they say which
 * module uses whose output. Branch (yes/no) and removed edges are never dropped.
 */
function reduceEdges(edges: VEdge[], sinks: Set<string>): VEdge[] {
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const reachableWithout = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = (out.get(from) ?? []).filter((t) => t !== to);
    while (stack.length) {
      const n = stack.pop()!;
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(out.get(n) ?? []));
    }
    return false;
  };
  return edges.filter((e) => {
    if (e.kind === 'branch' || e.kind === 'removed') return true;
    const candidate = e.source === '__entry' || e.target === '__exit' || sinks.has(e.target);
    return !candidate || !reachableWithout(e.source, e.target);
  });
}

function stepNode(g: ModuleGraph, step: Step, focusOp?: string, focusPath?: Set<string>, ghost = false, before = false): VNode {
  const focus = !!focusOp && !!step.target && (step.target === focusOp || (focusOp.startsWith(MODULE_TARGET) && g.operations[step.target]?.moduleId === focusOp.slice(MODULE_TARGET.length)));
  const onPath = !focus && !!step.target && !!focusPath?.has(step.target);
  const through = (step as Step & { through?: string }).through;
  const marks = step as Step & { beforeMark?: string; conditionNow?: string };
  const extra = { condition: step.condition, loop: step.loop, via: step.via, through, line: step.line, file: step.file, focus, onPath, delta: step.delta, conditionBefore: step.conditionBefore, ghost, beforeMark: marks.beforeMark, conditionNow: marks.conditionNow, transaction: step.transaction };
  if (step.kind === 'call') {
    // What the module got and returned in the request being followed: one extra line pair on the node.
    const op = g.operations[step.target!];
    const examples = ghost || (before && !untouched(op)) ? undefined : op?.examples;
    const node = moduleNode(g, step.id, step.target!, { ...extra, examples, ...(before && op ? { chipsOverride: chipsBefore(op), change: 'unchanged', containsChanges: false, hasDiff: false, beforeView: true } : {}) });
    if (examples?.length) node.height += 40;
    return node;
  }
  const deltaLine = step.delta || marks.beforeMark === 'removed' ? 18 : 0;
  const nameLines = Math.max(1, Math.ceil((step.effect?.target.length ?? 0) / 28));
  return { id: step.id, type: 'effect', width: 250, height: 58 + (nameLines - 1) * 17 + (step.condition ? 18 : 0) + (step.transaction ? 18 : 0) + deltaLine, data: { ...extra, effect: step.effect } };
}

/** Same code and nothing below it changed: what was recorded on the new code holds for the old one too. */
function untouched(op: Operation | undefined): boolean {
  return !!op && op.change === 'unchanged' && !op.containsChanges;
}

export function resourceId(e: Effect): string {
  return `res:${resourceKind(e)}:${e.target}`;
}

export function resourceKind(e: Effect): 'table' | 'outbox' | 'topic' | 'service' | 'queue' | 'event' {
  if (e.kind.startsWith('db.')) return 'table';
  return ({ outbox: 'outbox', kafka: 'topic', queue: 'queue', event: 'event' } as const)[e.kind as 'outbox'] ?? 'service';
}

function verb(e: Effect): string {
  return { 'db.read': 'reads', 'db.write': 'writes', outbox: 'emits', kafka: 'produces', http: 'calls', queue: 'enqueues', event: 'emits' }[e.kind];
}

// ---------------- zoom-out (impact) ----------------

export interface CallerIndex {
  /** op id -> scope ids (ops or entries) that call it directly */
  callers: Map<string, Set<string>>;
  /** op id -> entry ids that reach it */
  reach: Map<string, Set<string>>;
}

export function buildIndex(g: ModuleGraph): CallerIndex {
  const callers = new Map<string, Set<string>>();
  for (const [scopeId, scope] of Object.entries(g.scopes)) {
    const owner = g.operations[scopeId] ?? g.entryPoints[scopeId];
    if (!owner || owner.change === 'removed') continue;
    for (const step of scope.steps) {
      if (!step.target) continue;
      if (!callers.has(step.target)) callers.set(step.target, new Set());
      callers.get(step.target)!.add(scopeId);
    }
  }
  const reach = new Map<string, Set<string>>();
  const reachOf = (opId: string, stack: Set<string>): Set<string> => {
    if (reach.has(opId)) return reach.get(opId)!;
    const out = new Set<string>();
    if (stack.has(opId)) return out;
    stack.add(opId);
    for (const c of callers.get(opId) ?? []) {
      if (g.entryPoints[c]) out.add(c);
      else reachOf(c, stack).forEach((e) => out.add(e));
    }
    stack.delete(opId);
    reach.set(opId, out);
    return out;
  };
  for (const opId of Object.keys(g.operations)) reachOf(opId, new Set());
  return { callers, reach };
}

export interface ImpactOptions {
  depth: number;
  groupThreshold: number;
  expandedGroups: Set<string>;
}

export interface ImpactModel extends Model {
  /** Lazy graphs: visible operations whose callers are not loaded yet. */
  frontier: string[];
  maxDepth: number;
  entriesShown: number;
  entriesTotal: number;
}

/**
 * Start at an operation (or every operation of a module) and walk callers outwards, `depth` levels, until entry
 * points: "show references", like an IDE's, but up to the APIs and consumers that end up here.
 */
export function impactModel(g: ModuleGraph, index: CallerIndex, opId: string, opts: ImpactOptions): ImpactModel {
  const starts = targetOps(g, opId);
  const startSet = new Set(starts);
  const level = new Map<string, number>(starts.map((s) => [s, 0]));
  const edges: VEdge[] = [];
  let frontier = [...starts];
  let maxDepth = 0;
  for (let d = 1; frontier.length; d++) {
    const next: string[] = [];
    for (const callee of frontier) {
      for (const caller of index.callers.get(callee) ?? []) {
        if (startSet.has(caller)) continue; // the module calling itself
        if (d <= opts.depth) edges.push({ id: `c:${caller}->${callee}`, source: caller, target: callee, kind: 'call', highlight: true });
        if (level.has(caller)) continue;
        level.set(caller, d);
        if (!g.entryPoints[caller]) next.push(caller);
      }
    }
    frontier = next;
  }
  maxDepth = level.size ? Math.max(...level.values()) : 0;
  const visible = [...level.entries()].filter(([, l]) => l <= opts.depth).map(([id]) => id);
  const visibleSet = new Set(visible);
  const nodes: VNode[] = [];
  const entries = visible.filter((id) => g.entryPoints[id]);

  // Group entry points when there are too many to read (e.g. 50 APIs through one module).
  const groupOf = (entryId: string) => {
    const e = g.entryPoints[entryId];
    if (e.kind === 'api') {
      const path = e.label.split(' ')[1] ?? '';
      return `group:api ${path.split('/').slice(0, 3).join('/')}/*`;
    }
    return `group:${e.kind}`;
  };
  const grouped = new Map<string, string[]>();
  if (entries.length > opts.groupThreshold) {
    for (const id of entries) {
      const gid = groupOf(id);
      if (opts.expandedGroups.has(gid)) continue;
      grouped.set(gid, [...(grouped.get(gid) ?? []), id]);
    }
  }
  const groupFor = new Map<string, string>();
  for (const [gid, ids] of grouped) {
    if (ids.length < 2) continue;
    ids.forEach((id) => groupFor.set(id, gid));
    const items = ids.map((id) => g.entryPoints[id]);
    nodes.push({
      id: gid,
      type: 'entrygroup',
      width: 250,
      height: 74,
      data: {
        groupId: gid,
        label: gid.replace(/^group:/, '').replace(/^api /, ''),
        kind: items[0].kind,
        count: ids.length,
        warn: items.filter((e) => e.readOnly && e.effectsAdded?.some((x) => x.kind !== 'db.read' && x.kind !== 'http')).length,
        changed: items.filter((e) => e.containsChanges).length,
      },
    });
  }

  // Callers are shown per module (reviewers think in modules); the focus operation stays on its own.
  const nodeOf = (id: string) =>
    g.entryPoints[id] ? groupFor.get(id) ?? id : startSet.has(id) ? opId : `mod:${g.operations[id]?.moduleId ?? id}`;
  const reachOf = (ids: string[]) => new Set(ids.flatMap((o) => [...(index.reach.get(o) ?? [])]));
  const opsByModule = new Map<string, string[]>();
  for (const id of visible) {
    if (g.entryPoints[id]) {
      if (!groupFor.has(id)) nodes.push(entryNode(g, g.entryPoints[id], id, { compact: true }));
    } else if (id === opId) {
      nodes.push(moduleNode(g, id, id, { focus: true, inImpact: true, reach: index.reach.get(id)?.size ?? 0 }));
    } else if (startSet.has(id)) {
      if (id !== starts[0]) continue;
      // The whole module: one node listing its operations, with what the change did to any of them.
      const chips = new Map<string, Chip>();
      for (const o of starts) for (const c of chipsFor(g.operations[o])) chips.set(`${c.kind}${c.target}${c.delta ?? ''}`, c);
      const changed = starts.find((o) => g.operations[o].change !== 'unchanged');
      nodes.push(moduleNode(g, opId, changed ?? starts[0], {
        focus: true, inImpact: true, ops: starts.map((o) => g.operations[o].name), opIds: starts,
        chipsOverride: [...chips.values()], reach: reachOf(starts).size, zoomTarget: opId,
      }));
    } else {
      opsByModule.set(nodeOf(id), [...(opsByModule.get(nodeOf(id)) ?? []), id]);
    }
  }
  for (const [nid, ops] of opsByModule) {
    const chips = new Map<string, Chip>();
    for (const o of ops) for (const c of chipsFor(g.operations[o])) if (c.delta) chips.set(`${c.kind}${c.target}${c.delta}`, c);
    const reach = reachOf(ops);
    const changed = ops.find((o) => g.operations[o].change !== 'unchanged');
    nodes.push(
      moduleNode(g, nid, changed ?? ops[0], {
        compact: true,
        ops: ops.map((o) => g.operations[o].name),
        opIds: ops,
        chipsOverride: [...chips.values()],
        reach: reach.size,
      }),
    );
  }
  // Lazy graphs: callers not looked up yet hang off the node as a "load" stub.
  const unloaded = g.lazy ? visible.filter((id) => g.operations[id] && !g.operations[id].lazy?.callersLoaded) : [];
  const frontierByNode = new Map<string, string[]>();
  for (const id of unloaded) frontierByNode.set(nodeOf(id), [...(frontierByNode.get(nodeOf(id)) ?? []), id]);
  const finalEdges = new Map<string, VEdge>();
  for (const e of edges) {
    if (!visibleSet.has(e.source) || !visibleSet.has(e.target)) continue;
    const source = nodeOf(e.source);
    const target = nodeOf(e.target);
    if (source === target) continue;
    const key = `${source}->${target}`;
    finalEdges.set(key, { ...e, id: `c:${key}`, source, target });
  }
  for (const [nid, ops] of frontierByNode) {
    nodes.push({ id: `fr:${nid}`, type: 'frontier', width: 190, height: 40, data: { opIds: ops } });
    finalEdges.set(`fr:${nid}`, { id: `fr:${nid}`, source: `fr:${nid}`, target: nid, kind: 'control' });
  }
  return {
    nodes,
    edges: [...finalEdges.values()],
    frontier: unloaded,
    maxDepth,
    entriesShown: entries.length,
    entriesTotal: reachOf(starts).size,
  };
}

/** Lines an example value takes in a node: one per top-level key (objects) or one line. */
export function exampleKeyCount(value: unknown): number {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 1;
}
