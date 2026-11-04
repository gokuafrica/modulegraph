import type { Effect, EntryPoint, ModuleGraph, Operation, Param, Step } from '../../../schema/modulegraph.ts';

export type NodeKind = 'module' | 'effect' | 'entry' | 'exit' | 'resource' | 'entrygroup' | 'code' | 'decision' | 'frontier';
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
  const op = g.operations[opId];
  return op ? `${g.modules[op.moduleId]?.name ?? op.moduleId}.${op.name}` : opId;
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

function moduleNode(g: ModuleGraph, id: string, opId: string, extra: Record<string, unknown> = {}): VNode {
  const op = g.operations[opId];
  // Lazy graphs can reference operations that are not analyzed yet: name them from their class.
  const mod = op ? g.modules[op.moduleId] : Object.values(g.modules).find((m) => m.className === opId.split('.')[0]);
  const all = (extra.chipsOverride as Chip[] | undefined) ?? (op ? chipsFor(op) : []);
  // Compact (zoom-out) nodes only show what the change did to their effects; the full list is in the inspector.
  const chips = extra.compact && !extra.focus ? all.filter((c) => c.delta) : all;
  const shown = Math.min(chips.length, 6);
  const opsLines = Array.isArray(extra.ops) ? Math.ceil((extra.ops as string[]).length / 2) : 0;
  const deltaLine = extra.delta || extra.conditionBefore !== undefined ? 18 : 0;
  const height = (extra.compact ? 56 : 62) + (extra.compact ? shown : Math.ceil(shown / 2)) * 24 + (extra.condition ? 20 : 0) + (extra.via ? 16 : 0) + opsLines * 16 + deltaLine;
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

const exitLabel: Record<EntryPoint['kind'], string> = { api: 'HTTP response', grpc: 'gRPC reply', consumer: 'commit offset', cron: 'job finished' };

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
}

/** Entry → steps → exit for one scope (entry point or operation). */
export function flowModel(g: ModuleGraph, scopeId: string, opts: FlowOptions): Model & { chain: string[] } {
  const chain = [scopeId];
  let scope = g.scopes[scopeId];
  if (opts.collapsePassthrough) {
    while (scope && scope.steps.length === 1 && scope.steps[0].kind === 'call' && g.scopes[scope.steps[0].target!]?.steps.length) {
      const next = scope.steps[0].target!;
      if (chain.includes(next)) break;
      chain.push(next);
      scope = g.scopes[next];
    }
  }
  const nodes: VNode[] = [];
  const edges: VEdge[] = [];
  if (!scope) return { nodes, edges, chain };
  const via = chain.slice(1).map((id) => opTitle(g, id));
  const rootEntry = g.entryPoints[scopeId];
  const innerOp = g.operations[chain.at(-1)!];

  const examples = innerOp?.examples;
  const exampleParams = innerOp && examples?.length ? innerOp.params.map((p) => p.name) : [];
  if (rootEntry) {
    const node = entryNode(g, rootEntry, '__entry', { via: via.join(' › ') || undefined, examples, exampleParams });
    node.height += exampleParams.length ? 22 + exampleParams.length * 16 : 0;
    nodes.push(node);
  } else {
    nodes.push({
      id: '__entry',
      type: 'entry',
      width: 260,
      height: 50 + scope.params.length * 18 + (exampleParams.length ? 22 + exampleParams.length * 16 : 0),
      data: { kind: 'input', label: `${opTitle(g, chain.at(-1)!)}(…)`, params: scope.params, change: 'unchanged', paramsDelta: innerOp?.delta?.params, examples, exampleParams },
    });
  }

  // Steps guarded by `if (x)` / `unless (x)` hang off one decision node per condition, so exclusive
  // branches read as yes/no instead of two parallel arrows.
  const branchOf = new Map<string, { dec: string; branch: 'yes' | 'no' }>();
  const decisions = new Map<string, string>();
  for (const step of scope.steps) {
    const m = /^(if|unless) \((.+)\)$/.exec(step.condition ?? '');
    if (!m || step.condition!.includes(') and ')) continue;
    if (!decisions.has(m[2])) decisions.set(m[2], `__dec${decisions.size}`);
    branchOf.set(step.id, { dec: decisions.get(m[2])!, branch: m[1] === 'if' ? 'yes' : 'no' });
  }
  for (const [cond, id] of decisions) {
    nodes.push({ id, type: 'decision', width: Math.max(130, cond.length * 7.5 + 40), height: 46, data: { label: `${cond}?` } });
  }
  for (const step of scope.steps) {
    nodes.push(stepNode(g, branchOf.has(step.id) ? { ...step, condition: undefined } : step, opts.focusOp, opts.focusPath));
  }
  // Steps the base had and the head dropped stay visible as ghosts, so a removed call is as easy to spot as an added one.
  for (const step of scope.removedSteps ?? []) nodes.push(stepNode(g, step, undefined, undefined, true));
  if (scope.steps.length === 0 && innerOp) {
    const lines = innerOp.source.split('\n').length;
    const changes = innerOp.changes ?? [];
    const height = changes.length ? Math.min(70 + changes.length * 22 + Math.min(changes[0].diff.length, 14) * 16, 420) : Math.min(60 + lines * 15, 340);
    nodes.push({ id: '__code', type: 'code', width: changes.length ? 560 : 440, height, data: { opId: innerOp.id, source: innerOp.source, changes } });
    edges.push({ id: 'e:in-code', source: '__entry', target: '__code', kind: 'control' }, { id: 'e:code-out', source: '__code', target: '__exit', kind: 'control' });
  }

  const returns = scope.returns;
  const before = innerOp?.delta?.returns?.before.fields;
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
      fields: fieldsWithDelta(returns?.fields, innerOp?.delta?.returns ? before : undefined),
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

  const reduced = reduceEdges(edges, new Set(nodes.filter((n) => n.type === 'effect' || n.type === 'decision').map((n) => n.id)));
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
  return { nodes, edges: [...new Map(edges.map((e) => [e.id, e])).values()], chain };
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

function stepNode(g: ModuleGraph, step: Step, focusOp?: string, focusPath?: Set<string>, ghost = false): VNode {
  const focus = !!focusOp && step.target === focusOp;
  const onPath = !focus && !!step.target && !!focusPath?.has(step.target);
  const extra = { condition: step.condition, loop: step.loop, via: step.via, line: step.line, file: step.file, focus, onPath, delta: step.delta, conditionBefore: step.conditionBefore, ghost };
  if (step.kind === 'call') return moduleNode(g, step.id, step.target!, extra);
  const deltaLine = step.delta || step.conditionBefore !== undefined ? 18 : 0;
  return { id: step.id, type: 'effect', width: 230, height: 50 + (step.condition ? 18 : 0) + deltaLine, data: { ...extra, effect: step.effect } };
}

export function resourceId(e: Effect): string {
  return `res:${resourceKind(e)}:${e.target}`;
}

export function resourceKind(e: Effect): 'table' | 'outbox' | 'topic' | 'service' {
  return e.kind.startsWith('db.') ? 'table' : e.kind === 'outbox' ? 'outbox' : e.kind === 'kafka' ? 'topic' : 'service';
}

function verb(e: Effect): string {
  return { 'db.read': 'reads', 'db.write': 'writes', outbox: 'emits', kafka: 'produces', http: 'calls' }[e.kind];
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

/** Start at an operation and walk callers outwards, `depth` levels, until entry points. */
export function impactModel(g: ModuleGraph, index: CallerIndex, opId: string, opts: ImpactOptions): ImpactModel {
  const level = new Map<string, number>([[opId, 0]]);
  const edges: VEdge[] = [];
  let frontier = [opId];
  let maxDepth = 0;
  for (let d = 1; frontier.length; d++) {
    const next: string[] = [];
    for (const callee of frontier) {
      for (const caller of index.callers.get(callee) ?? []) {
        if (d <= opts.depth) edges.push({ id: `c:${caller}->${callee}`, source: caller, target: callee, kind: 'call', highlight: true });
        if (level.has(caller)) continue;
        level.set(caller, d);
        if (!g.entryPoints[caller]) next.push(caller);
      }
    }
    frontier = next;
  }
  maxDepth = Math.max(...level.values());
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
    g.entryPoints[id] ? groupFor.get(id) ?? id : id === opId ? id : `mod:${g.operations[id]?.moduleId ?? id}`;
  const opsByModule = new Map<string, string[]>();
  for (const id of visible) {
    if (g.entryPoints[id]) {
      if (!groupFor.has(id)) nodes.push(entryNode(g, g.entryPoints[id], id, { compact: true }));
    } else if (id === opId) {
      nodes.push(moduleNode(g, id, id, { focus: true, inImpact: true, reach: index.reach.get(id)?.size ?? 0 }));
    } else {
      opsByModule.set(nodeOf(id), [...(opsByModule.get(nodeOf(id)) ?? []), id]);
    }
  }
  for (const [nid, ops] of opsByModule) {
    const chips = new Map<string, Chip>();
    for (const o of ops) for (const c of chipsFor(g.operations[o])) if (c.delta) chips.set(`${c.kind}${c.target}${c.delta}`, c);
    const reach = new Set(ops.flatMap((o) => [...(index.reach.get(o) ?? [])]));
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
    entriesTotal: index.reach.get(opId)?.size ?? 0,
  };
}

/** Lines an example value takes in a node: one per top-level key (objects) or one line. */
export function exampleKeyCount(value: unknown): number {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 1;
}
