import type { Effect, Finding, ReviewSummary, Risk } from '../../schema/modulegraph.ts';
import type { Graphish } from './compare.ts';
import type { Config } from './config.ts';
import { dedupeEffects, effectKey } from './extract.ts';
import type { RawDiff } from './git.ts';

const fmt = (e: Effect) => `${e.kind} \`${e.target}\``;

export function opLabel(g: Graphish, opId: string): string {
  const op = g.operations[opId];
  return op ? `${g.modules[op.moduleId]?.name ?? op.moduleId}.${op.name}` : opId;
}

/** op id -> entry point ids whose flow reaches it (the reference index behind zoom-out). */
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

  // R3: a module's real direct side effects must match its declared contract.
  if (config.rules.requireDeclaredEffects) {
    for (const mod of Object.values(g.modules)) {
      if (mod.change === 'removed') continue;
      const actual = dedupeEffects(live.filter((op) => op.moduleId === mod.id).flatMap((op) => op.directEffects));
      const declared = new Set(mod.declaredEffects.map(effectKey));
      for (const effect of actual.filter((e) => !declared.has(effectKey(e)))) {
        findings.push({
          rule: 'undeclared-effect',
          severity: 'error',
          message: `${mod.name} performs ${fmt(effect)} but its contract does not declare it`,
          subject: { type: 'module', id: mod.id },
          isNew: false,
          hint: `Declare it with \`@effect ${effect.kind} ${effect.target}\` on ${mod.className}, or move the side effect to the module that owns it.`,
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

  // Read-only entry points (GET, gRPC Get*) should not write.
  for (const entry of Object.values(g.entryPoints)) {
    if (!entry.readOnly || entry.change === 'removed') continue;
    const writes = entry.effects.filter((e) => e.kind !== 'db.read' && e.kind !== 'http');
    if (writes.length) {
      findings.push({
        rule: 'read-path-writes',
        severity: 'warning',
        message: `${entry.label} is read-only by protocol but performs ${writes.map(fmt).join(', ')}`,
        subject: { type: 'entry', id: entry.id },
        isNew: false,
      });
    }
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
  for (const file of diff.files.filter((f) => f.modules.length === 0 && /\.tsx?$/.test(f.path))) {
    findings.push({
      rule: 'unattributed-change',
      severity: 'info',
      message: `${file.path} changed but belongs to no module. It may still affect module contracts through shared types`,
      subject: { type: 'file', id: file.path },
      isNew: true,
    });
  }

  // R9: side effects added by the change but not mentioned in the stated intent.
  if (intent) {
    const text = intent.toLowerCase();
    const added = dedupeEffects(contractChanges.flatMap((op) => op.delta!.effectsAdded.filter((e) => op.directEffects.some((d) => effectKey(d) === effectKey(e)))));
    for (const effect of added.filter((e) => !text.includes(e.target.toLowerCase()))) {
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
      return {
        operation: op.id,
        risk: d?.risk ?? 'low',
        reason: reasons.join('; ') || 'implementation only',
        reach: reach.get(op.id)?.size ?? 0,
      };
    })
    .sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk] || b.reach - a.reach);
  const changedModules = Object.values(g.modules).filter((m) => m.change !== 'unchanged').map((m) => m.id);
  const reviewers = [
    ...new Set(
      changed.filter((op) => op.delta && !op.delta.implementationOnly).map((op) => g.modules[op.moduleId]?.owner).filter(Boolean) as string[],
    ),
  ];
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
