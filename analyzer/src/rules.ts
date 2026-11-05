import type { Effect, Finding, ReviewSummary, Risk } from '../../schema/modulegraph.ts';
import type { Graphish } from './compare.ts';
import type { Config } from './config.ts';
import { dedupeEffects, effectKey } from './effects.ts';
import type { RawDiff } from './git.ts';

const fmt = (e: Effect) => `${e.kind} \`${e.target}\``;

export function opLabel(g: Graphish, opId: string): string {
  const op = g.operations[opId];
  return op ? `${g.modules[op.moduleId]?.name ?? op.moduleId}.${op.name}` : opId;
}

/** op id -> entry point ids whose flow reaches it (the reference index behind zoom-out). */
/**
 * The modules a changed file belongs to: the module whose class lives there, the operations that inline code from
 * it, and otherwise the modules in the same folder (a module's own types or constants file has no class of its own).
 */
export function modulesOfFile(g: Graphish, path: string): string[] {
  const viaOps = Object.values(g.operations).filter((op) => op.changes?.some((c) => c.file === path)).map((op) => op.moduleId);
  const own = [...new Set([...Object.values(g.modules).filter((m) => m.file === path).map((m) => m.id), ...viaOps])];
  if (own.length) return own;
  const dir = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);
  return Object.values(g.modules).filter((m) => m.file && dir(m.file) === dir(path)).map((m) => m.id);
}

export function reachIndex(g: Graphish): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const entry of Object.values(g.entryPoints)) {
    if (entry.change === 'removed') continue;
    const seen = new Set<string>();
    const walk = (scopeId: string) => {
      for (const step of g.scopes[scopeId]?.steps ?? []) {
        if (!step.target || seen.has(step.target)) continue;
        seen.add(step.target);
        walk(step.target);
      }
    };
    walk(entry.id);
    for (const opId of seen) {
      if (!index.has(opId)) index.set(opId, new Set());
      index.get(opId)!.add(entry.id);
    }
  }
  return index;
}

/** Architecture rules evaluated on one revision. Run on base and head; head-only findings are "new". */
export function architectureFindings(g: Graphish, config: Config): Finding[] {
  const findings: Finding[] = [];
  const live = Object.values(g.operations).filter((op) => op.change !== 'removed');

  // R3: where a contract is declared (external config, or opt-in tags), real direct effects must match it.
  if (config.rules.requireDeclaredEffects) {
    for (const mod of Object.values(g.modules)) {
      if (mod.change === 'removed' || !mod.contractSource) continue;
      const actual = dedupeEffects(live.filter((op) => op.moduleId === mod.id).flatMap((op) => op.directEffects));
      const declared = new Set(mod.declaredEffects.map(effectKey));
      for (const effect of actual.filter((e) => !declared.has(effectKey(e)))) {
        findings.push({
          rule: 'undeclared-effect',
          severity: 'error',
          message: `${mod.name} performs ${fmt(effect)} but its contract does not declare it`,
          subject: { type: 'module', id: mod.id },
          isNew: false,
          hint: `Add "${effect.kind} ${effect.target}" to ${mod.className}'s effects in the modulegraph config, or move the side effect to the module that owns it.`,
        });
      }
      const actualKeys = new Set(actual.map(effectKey));
      for (const effect of mod.declaredEffects.filter((e) => !actualKeys.has(effectKey(e)))) {
        findings.push({
          rule: 'stale-declaration',
          severity: 'warning',
          message: `${mod.name} declares ${fmt(effect)} but never performs it`,
          subject: { type: 'module', id: mod.id },
          isNew: false,
        });
      }
    }
  }

  // R6: table ownership. Only the owning module writes a table.
  for (const op of live) {
    for (const effect of op.directEffects.filter((e) => e.kind === 'db.write')) {
      const owner = config.rules.tableOwners[effect.target];
      if (owner && owner !== op.moduleId) {
        findings.push({
          rule: 'table-ownership',
          severity: 'error',
          message: `${opLabel(g, op.id)} writes \`${effect.target}\`, which is owned by ${g.modules[owner]?.name ?? owner}`,
          subject: { type: 'operation', id: op.id },
          isNew: false,
          hint: `Call ${g.modules[owner]?.name ?? owner} instead of writing its table directly.`,
        });
      }
    }
  }

  // R6: module dependency graph must be acyclic.
  const deps = new Map<string, Set<string>>();
  for (const op of live) {
    for (const callee of op.calls) {
      const to = g.operations[callee]?.moduleId;
      if (to && to !== op.moduleId) deps.set(op.moduleId, new Set([...(deps.get(op.moduleId) ?? []), to]));
    }
  }
  const reported = new Set<string>();
  const visit = (mod: string, path: string[]) => {
    for (const next of deps.get(mod) ?? []) {
      const at = path.indexOf(next);
      if (at >= 0) {
        const cycle = [...path.slice(at), next].map((m) => g.modules[m]?.name ?? m);
        const key = [...cycle.slice(0, -1)].sort().join('|');
        if (!reported.has(key)) {
          reported.add(key);
          findings.push({ rule: 'module-cycle', severity: 'error', message: `Module cycle: ${cycle.join(' → ')}`, subject: { type: 'module', id: next }, isNew: false });
        }
      } else if (path.length < 20) visit(next, [...path, next]);
    }
  };
  for (const mod of deps.keys()) visit(mod, [mod]);

  // The same read twice in one operation is redundant I/O (a common pattern in generated code). Reads on
  // exclusive branches (`if (x)` here, `unless (x)` there) never both run, so they don't count together.
  for (const op of live) {
    const byKey = new Map<string, (string | undefined)[]>();
    for (const step of g.scopes[op.id]?.steps ?? []) {
      if (!step.effect || step.loop || (step.effect.kind !== 'db.read' && step.effect.kind !== 'http')) continue;
      const key = effectKey(step.effect);
      byKey.set(key, [...(byKey.get(key) ?? []), step.condition]);
    }
    for (const [key, conditions] of byKey) {
      const n = mostTogether(conditions);
      if (n > 1) {
        findings.push({
          rule: 'duplicate-read',
          severity: 'warning',
          message: `${opLabel(g, op.id)} performs ${key} ${n}× in one call`,
          subject: { type: 'operation', id: op.id },
          isNew: false,
          hint: 'Read once and reuse the value.',
        });
      }
    }
  }

  // The same table read again through a module: `forUser()` reads document_birth_info, then `get()` reads it again
  // to build the answer. Each read is fine on its own; together, one of them is usually redundant.
  for (const op of live) {
    const byTable = new Map<string, { who: string; condition?: string; through: boolean }[]>();
    for (const step of g.scopes[op.id]?.steps ?? []) {
      if (step.loop) continue;
      const callee = step.target ? g.operations[step.target] : undefined;
      const tables = new Set((step.effect ? [step.effect] : callee?.effects ?? []).filter((e) => e.kind === 'db.read').map((e) => e.target));
      for (const t of tables) byTable.set(t, [...(byTable.get(t) ?? []), { who: callee ? opLabel(g, callee.id) : 'directly', condition: step.condition, through: !!callee }]);
    }
    for (const [table, reads] of byTable) {
      if (!reads.some((r) => r.through) || mostTogether(reads.map((r) => r.condition)) < 2) continue;
      findings.push({
        rule: 'repeat-read',
        severity: 'warning',
        message: `${opLabel(g, op.id)} reads ${table} ${reads.length}× in one call: ${reads.map((r) => r.who).join(', then ')}`,
        subject: { type: 'operation', id: op.id },
        isNew: false,
        hint: 'Pass down the value already read, or say why it must be read again.',
      });
    }
  }

  // Shared expensive fetches must happen once per flow (e.g. Identity is fetched by the orchestrator and passed down).
  for (const entry of Object.values(g.entryPoints)) {
    if (entry.change === 'removed') continue;
    const counts = new Map<string, number>();
    const walk = (scopeId: string, stack: Set<string>) => {
      for (const step of g.scopes[scopeId]?.steps ?? []) {
        if (!step.target || stack.has(step.target)) continue;
        counts.set(step.target, (counts.get(step.target) ?? 0) + 1);
        stack.add(step.target);
        walk(step.target, stack);
        stack.delete(step.target);
      }
    };
    walk(entry.id, new Set());
    for (const opId of config.rules.fetchOnce) {
      const n = counts.get(opId) ?? 0;
      if (n > 1) {
        findings.push({
          rule: 'fetch-once',
          severity: 'error',
          message: `${opLabel(g, opId)} runs ${n}× in ${entry.label}. It should be fetched once and passed down`,
          subject: { type: 'entry', id: entry.id },
          isNew: false,
        });
      }
    }
  }

  // Read-only entry points (GET, gRPC Get*) should not write. One finding per write, listing every entry it leaks into.
  const readPathWrites = new Map<string, { effect: Effect; entries: string[] }>();
  for (const entry of Object.values(g.entryPoints)) {
    if (!entry.readOnly || entry.change === 'removed') continue;
    for (const effect of entry.effects.filter((e) => e.kind !== 'db.read' && e.kind !== 'http')) {
      const slot = readPathWrites.get(effectKey(effect)) ?? { effect, entries: [] };
      slot.entries.push(entry.id);
      readPathWrites.set(effectKey(effect), slot);
    }
  }
  for (const { effect, entries } of readPathWrites.values()) {
    const labels = entries.map((id) => g.entryPoints[id].label);
    findings.push({
      rule: 'read-path-writes',
      severity: 'warning',
      message: `${fmt(effect)} runs on ${entries.length} read-only entry point${entries.length > 1 ? 's' : ''}: ${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ', …' : ''}`,
      subject: { type: 'entry', id: entries[0] },
      related: entries.map((id) => ({ type: 'entry' as const, id })),
      isNew: false,
      hint: 'Reads that write break caching, retries and replica routing. Move the write to a command path or make it explicit in the API contract.',
    });
  }
  return findings;
}

/** Rules about the change itself (size, AI-risk signals, disclosure). Always "new". */
export function changeFindings(g: Graphish, diff: RawDiff, config: Config, intent?: string): Finding[] {
  const findings: Finding[] = [];
  const { budget } = config.rules;
  const contractChanges = Object.values(g.operations).filter((op) => op.change !== 'unchanged' && op.delta && !op.delta.implementationOnly);
  const lines = diff.files.reduce((n, f) => n + f.added + f.removed, 0);

  // R4: review budget. Above it, ask for a stack of smaller PRs.
  const over = [
    contractChanges.length > budget.maxContractChanges && `${contractChanges.length} contract changes (budget ${budget.maxContractChanges})`,
    lines > budget.maxChangedLines && `${lines} changed lines (budget ${budget.maxChangedLines})`,
    diff.files.length > budget.maxFiles && `${diff.files.length} files (budget ${budget.maxFiles})`,
  ].filter(Boolean);
  if (over.length) {
    findings.push({
      rule: 'review-budget',
      severity: 'warning',
      message: `Change exceeds the review budget: ${over.join(', ')}`,
      isNew: true,
      hint: 'Split into a stack: one PR per contract change, each reviewable as its own graph diff.',
    });
  }

  // R3 without declarations: the base revision is the contract. Any side effect a change adds is surfaced where it
  // originates: its own code, or a new call to an operation that already did it (`runCheck` now calls `getStatus`).
  for (const op of Object.values(g.operations)) {
    if (op.change === 'removed' || !op.delta) continue;
    for (const effect of originatedAt(g, op)) {
      const writes = effect.kind !== 'db.read' && effect.kind !== 'http';
      findings.push({
        rule: 'new-side-effect',
        severity: writes ? 'warning' : 'info',
        message: `${opLabel(g, op.id)} now performs ${fmt(effect)}${op.change === 'added' ? ' (new operation)' : ''}`,
        subject: { type: 'operation', id: op.id },
        isNew: true,
        hint: writes ? 'A new write runs on every flow that reaches this module. Check the zoom-out view.' : undefined,
      });
    }
  }

  // R8: AI-written-code risk signals in added lines.
  const signals: [RegExp, string][] = [
    [/^\+.*\b(it|test|describe)\.(skip|only)\(/m, 'skipped or focused tests'],
    [/^\+.*(@ts-ignore|@ts-expect-error|eslint-disable)/m, 'suppressed type/lint checks'],
    [/^\+.*\|\|\s*true\b/m, '`|| true` that can mask failures'],
    [/^\+.*\bas any\b/m, '`as any` casts'],
  ];
  for (const [pattern, what] of signals) {
    if (pattern.test(diff.patch)) {
      findings.push({ rule: 'guardrail-weakened', severity: 'warning', message: `Diff adds ${what}`, isNew: true });
    }
  }
  for (const file of diff.files.filter((f) => f.status === 'deleted' && /\.(test|spec)\.tsx?$/.test(f.path))) {
    findings.push({ rule: 'guardrail-weakened', severity: 'error', message: `Test file deleted: ${file.path}`, isNew: true, subject: { type: 'file', id: file.path } });
  }
  const entryFiles = new Set(Object.values(g.entryPoints).map((e) => e.file));
  const outside = diff.files.filter((f) => f.modules.length === 0 && !entryFiles.has(f.path) && /\.tsx?$/.test(f.path));
  if (outside.length) {
    findings.push({
      rule: 'unattributed-change',
      severity: 'info',
      message: `${outside.length} changed file${outside.length > 1 ? 's' : ''} outside any module: ${outside.map((f) => f.path.split('/').slice(-2).join('/')).join(', ')}`,
      related: outside.map((f) => ({ type: 'file' as const, id: f.path })),
      isNew: true,
      hint: 'Wiring, shared types and dev tooling. Contract effects of shared types already show up as output-shape changes on the modules.',
    });
  }

  // R9: side effects added by the change but not mentioned in the stated intent.
  if (intent) {
    const text = intent.toLowerCase();
    const added = dedupeEffects(contractChanges.flatMap((op) => originatedAt(g, op).filter((e) =>
      // a new operation reading its data is implied by the operation; an existing one that starts reading is not
      e.kind !== 'db.read' || op.change === 'modified')));
    for (const effect of added.filter((e) => !mentions(intent, e.target))) {
      findings.push({
        rule: 'undisclosed-effect',
        severity: 'warning',
        message: `Change adds ${fmt(effect)}, which the PR description never mentions`,
        isNew: true,
        hint: 'Either the description is incomplete or the agent added a side effect nobody asked for.',
      });
    }
  }
  return findings;
}

/**
 * Effects this operation's change adds that no operation below it added: the change happened here. A new operation
 * answers for its own code only (what it calls shows as its calls); a changed one also for effects it gains by
 * newly calling an operation that already had them.
 */
function originatedAt(g: Graphish, op: Graphish['operations'][string]): Effect[] {
  if (op.change === 'added') {
    const direct = new Set(op.directEffects.map(effectKey));
    return (op.delta?.effectsAdded ?? []).filter((e) => direct.has(effectKey(e)));
  }
  const addedBelow = new Set<string>();
  const seen = new Set<string>();
  const stack = [...op.calls];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || id === op.id) continue;
    seen.add(id);
    const callee = g.operations[id];
    if (!callee) continue;
    callee.delta?.effectsAdded.forEach((e) => addedBelow.add(effectKey(e)));
    stack.push(...callee.calls);
  }
  return (op.delta?.effectsAdded ?? []).filter((e) => !addedBelow.has(effectKey(e)));
}

/** Guards of a step as `{ test, holds }`: `if (a) and unless (b)` → a holds, b does not. */
function guards(condition: string | undefined): { test: string; holds: boolean }[] {
  return (condition ?? '').split(/\) and (?=(?:if|unless) \()/).map((part) => /^(if|unless) \((.+?)\)?$/.exec(part.trim())).filter(Boolean)
    .map((m) => ({ test: m![2], holds: m![1] === 'if' }));
}

/** The largest number of these guarded steps that can run in the same call. */
function mostTogether(conditions: (string | undefined)[]): number {
  const gs = conditions.map(guards);
  const exclusive = (a: number, b: number) => gs[a].some((x) => gs[b].some((y) => x.test === y.test && x.holds !== y.holds));
  if (gs.length > 12) return gs.length;
  let best = 0;
  for (let mask = 1; mask < 1 << gs.length; mask++) {
    const picked = gs.map((_, i) => i).filter((i) => mask & (1 << i));
    if (picked.length > best && picked.every((a) => picked.every((b) => a >= b || !exclusive(a, b)))) best = picked.length;
  }
  return best;
}

const GENERIC = new Set([
  'requested', 'request', 'created', 'updated', 'changed', 'completed', 'event', 'events', 'resolved', 'ready', 'table', 'api', 'service',
  // host names: "the risk API" discloses risk.example.com
  'com', 'net', 'org', 'dev', 'www', 'svc', 'http', 'https', 'internal', 'local', 'cluster', 'example',
]);
const stem = (w: string) => {
  let s = w.replace(/(ies|s)$/, (m) => (m === 'ies' ? 'y' : ''));
  if (s.length > 5) s = s.replace(/(ed|ing)$/, '').replace(/([b-df-hj-np-tv-z])\1$/, '$1');
  return s;
};
const words = (t: string) =>
  t.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3).map(stem);

/** The intent mentions an effect target literally, or names all of its meaningful words close together ("manual review" for kyc.manual_review_requested). */
export function mentions(intent: string, target: string): boolean {
  if (intent.toLowerCase().includes(target.toLowerCase())) return true;
  // All meaningful words of the target, close together (within a few words), e.g. "manual-review outbox event".
  const said = words(intent);
  const needed = [...new Set(words(target).filter((w) => !GENERIC.has(w)))];
  if (!needed.length) return false;
  const span = needed.length + 2;
  return said.some((_, i) => needed.every((w) => said.slice(i, i + span).includes(w)));
}

export function markNew(head: Finding[], base: Finding[]): Finding[] {
  const key = (f: Finding) => `${f.rule}|${f.message}`;
  const seen = new Set(base.map(key));
  return head.map((f) => ({ ...f, isNew: f.isNew || !seen.has(key(f)) }));
}

const riskOrder: Record<Risk, number> = { high: 0, medium: 1, low: 2, none: 3 };

/** R2/R5/R10: review queue sorted by contract risk then reach, plus the owners to request. */
export function reviewSummary(g: Graphish, diff: RawDiff | undefined): ReviewSummary {
  const reach = reachIndex(g);
  const changed = Object.values(g.operations).filter((op) => op.change !== 'unchanged');
  const queue = changed
    .map((op) => {
      const d = op.delta;
      const reasons = [
        op.change === 'added' && 'new operation',
        op.change === 'removed' && 'removed operation',
        d?.params && 'signature changed',
        d?.returns && 'output shape changed',
        d?.effectsAdded.length && `+${d.effectsAdded.map((e) => `${e.kind} ${e.target}`).join(', +')}`,
        d?.effectsRemoved.length && `−${d.effectsRemoved.map((e) => `${e.kind} ${e.target}`).join(', −')}`,
        d?.callsAdded.length && `now calls ${d.callsAdded.map((c) => opLabel(g, c)).join(', ')}`,
      ].filter(Boolean) as string[];
      // Same contract, different behaviour: a step added, removed or now guarded differently (an event no longer
      // sent for some inputs) matters more than a refactor.
      const scope = g.scopes[op.id];
      const guardChanges = (scope?.steps ?? []).filter((s) => s.conditionBefore !== undefined).length;
      const stepChanges = (scope?.steps ?? []).filter((s) => s.delta === 'added').length + (scope?.removedSteps?.length ?? 0);
      const behaviour = guardChanges + stepChanges;
      if (behaviour && op.change === 'modified') {
        reasons.push(guardChanges ? `${guardChanges} guard${guardChanges > 1 ? 's' : ''} changed inside` : `${stepChanges} step${stepChanges > 1 ? 's' : ''} added or removed inside`);
      }
      const risk = (d?.risk ?? 'low') === 'low' && behaviour ? 'medium' : d?.risk ?? 'low';
      return {
        operation: op.id,
        risk,
        reason: reasons.join('; ') || 'implementation only',
        reach: reach.get(op.id)?.size ?? 0,
      };
    })
    .sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk] || b.reach - a.reach);
  const changedModules = Object.values(g.modules).filter((m) => m.change !== 'unchanged').map((m) => m.id);
  // Owners of contract changes first, then owners of modules whose behaviour changed inside (guards, steps).
  const contractFirst = [...changed].sort((a, b) => Number(!a.delta || a.delta.implementationOnly) - Number(!b.delta || b.delta.implementationOnly));
  const reviewers = [...new Set(contractFirst.map((op) => g.modules[op.moduleId]?.owner).filter(Boolean) as string[])];
  const affected = new Set(changed.flatMap((op) => [...(reach.get(op.id) ?? [])]));
  Object.values(g.entryPoints).filter((e) => e.change !== 'unchanged').forEach((e) => affected.add(e.id));
  return {
    changedModules,
    changedOperations: changed.map((op) => op.id),
    queue,
    reviewers,
    stats: {
      files: diff?.files.length ?? 0,
      linesAdded: diff?.files.reduce((n, f) => n + f.added, 0) ?? 0,
      linesRemoved: diff?.files.reduce((n, f) => n + f.removed, 0) ?? 0,
      contractChanges: changed.filter((op) => op.delta && !op.delta.implementationOnly).length,
      entryPointsAffected: affected.size,
    },
  };
}
