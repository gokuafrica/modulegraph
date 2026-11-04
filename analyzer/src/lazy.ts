import { join } from 'node:path';
import type { Project } from 'ts-morph';
import type { Example, ModuleGraph, Source } from '../../schema/modulegraph.ts';
import { compare } from './compare.ts';
import type { Config } from './config.ts';
import { Extractor } from './extract.ts';
import { hunks, type RawDiff } from './git.ts';
import { architectureFindings, changeFindings, markNew, reviewSummary } from './rules.ts';

export interface LazyOptions {
  /** How many entry points to analyze up front. */
  seedCount: number;
  /** Entry point ids or label fragments to analyze up front (an agent's pick); overrides the ranking. */
  seedHints?: string[];
  /** Upward search stops after this many caller levels even if fewer entry points were found. */
  maxLevels?: number;
}

export type ExpandAction = 'callers' | 'reach' | 'entry' | 'op';

/**
 * Builds the review graph on demand instead of all at once.
 *
 * 1. Map changed lines to the operations/entry points that contain them (directly, or through inlined helpers
 *    and changed types), using the TypeScript reference index. Analyze those, downward.
 * 2. Walk callers upward level by level, analyzing each caller's own scope only, until `seedCount` entry points
 *    are reached. Rank them against the PR (changed entry points, words from the title/intent, distance) and
 *    analyze the best ones fully.
 * 3. Everything else stays unanalyzed until the reviewer asks: callers of a node, all entry points of a change,
 *    a flow, or a drill-in. Both revisions are always analyzed to the same extent, so change status stays exact.
 */
export class LazySession {
  private head: Extractor;
  private base?: Extractor;
  private callersLoaded = new Set<string>();
  private seeds: { id: string; reason: string }[] = [];
  private ms = 0;

  constructor(
    headProject: Project,
    baseProject: Project | undefined,
    private repo: string,
    projectDir: string,
    private config: Config,
    private diff: RawDiff | undefined,
    private source: Source,
    private intent: string | undefined,
    public examples: Record<string, Example[]> = {},
  ) {
    this.head = new Extractor(headProject, repo, projectDir, config);
    if (baseProject) this.base = new Extractor(baseProject, repo, projectDir, config);
  }

  init(opts: LazyOptions): void {
    this.timed(() => {
      for (const x of this.sides()) {
        x.init();
        x.listEntryPoints();
      }
      const changed = this.changedScopes();
      for (const id of changed) this.ensure(id, true);
      this.pickSeeds(changed, opts);
    });
  }

  /** Every module method, for recording example calls (cheap: no analysis). */
  exampleTargets() {
    return this.head.operationTargets();
  }

  expand(action: ExpandAction, id: string): void {
    this.timed(() => {
      if (action === 'callers') this.loadCallers(id);
      else if (action === 'reach') this.loadReach(id);
      else this.ensure(id, true);
    });
  }

  graph(): ModuleGraph {
    for (const x of this.sides()) x.computeTransitiveEffects();
    const head = this.head.snapshot;
    const base = this.base?.snapshot;
    const g = compare(head, base);
    for (const [opId, ex] of Object.entries(this.examples)) if (g.operations[opId]) g.operations[opId].examples = ex;
    // Complete downward = every operation below is analyzed; only then are its transitive effects final.
    const complete = new Map<string, boolean>();
    const isComplete = (opId: string, stack = new Set<string>()): boolean => {
      if (complete.has(opId)) return complete.get(opId)!;
      const op = g.operations[opId];
      if (!op) return false;
      if (stack.has(opId)) return true;
      stack.add(opId);
      const ok = this.head.deep.has(opId) || op.calls.every((c) => isComplete(c, stack));
      stack.delete(opId);
      complete.set(opId, ok);
      return ok;
    };
    for (const op of Object.values(g.operations)) {
      op.lazy = { callersLoaded: this.callersLoaded.has(op.id), calleesLoaded: isComplete(op.id) };
    }
    for (const e of Object.values(g.entryPoints)) {
      e.analysis = this.head.deep.has(e.id) || (this.base?.deep.has(e.id) && !head.entryPoints[e.id]) ? 'full' : g.scopes[e.id] ? 'reached' : 'listed';
    }
    for (const file of this.source.files) {
      const viaOps = Object.values(g.operations).filter((op) => op.changes?.some((c) => c.file === file.path)).map((op) => op.moduleId);
      file.modules = [...new Set([...Object.values(g.modules).filter((m) => m.file === file.path).map((m) => m.id), ...viaOps])];
    }
    let findings = architectureFindings(g, this.config);
    if (base) {
      findings = markNew(findings, architectureFindings(compare(base), this.config));
      findings.push(...changeFindings(g, this.diff!, this.config, this.intent));
    }
    const entries = Object.values(g.entryPoints);
    return {
      schema: 'modulegraph/v1',
      service: this.config.service,
      generatedAt: new Date().toISOString(),
      generator: 'modulegraph-analyzer/0.2 (ts-morph, lazy)',
      source: this.source,
      ...g,
      findings,
      review: reviewSummary(g, this.diff),
      lazy: {
        seeds: this.seeds,
        stats: {
          entryPointsKnown: entries.length,
          entryPointsAnalyzed: entries.filter((e) => e.analysis === 'full').length,
          entryPointsReached: entries.filter((e) => e.analysis === 'reached').length,
          operationsKnown: new Set([...this.head.knownOperations(), ...(this.base?.knownOperations() ?? [])]).size,
          operationsAnalyzed: Object.keys(g.operations).length,
          ms: Math.round(this.ms),
        },
      },
    };
  }

  // ---------- steps ----------

  /** Operations and entry points whose code the diff touches, on either side. */
  private changedScopes(): string[] {
    if (!this.diff) return [];
    const out = new Set<string>();
    for (const f of hunks(this.diff.patch)) {
      if (f.head.length) this.head.scopesForLines(abs(this.repo, f.path), f.head).forEach((id) => out.add(id));
      if (f.base.length && this.base) this.base.scopesForLines(abs(this.repo, f.basePath ?? f.path), f.base).forEach((id) => out.add(id));
    }
    return [...out];
  }

  private pickSeeds(changed: string[], opts: LazyOptions): void {
    const isEntry = (id: string) => !!(this.head.snapshot.entryPoints[id] ?? this.base?.snapshot.entryPoints[id]);
    const level = new Map<string, number>();
    for (const id of changed) if (isEntry(id)) level.set(id, 0);
    let frontier = changed.filter((id) => !isEntry(id));
    const visited = new Set(frontier);
    // Closest callers first: changed operations that are themselves called by other changed ones go last.
    frontier.sort((x, y) => Number(changed.some((c) => this.head.snapshot.operations[c]?.calls.includes(x))) - Number(changed.some((c) => this.head.snapshot.operations[c]?.calls.includes(y))));
    for (let d = 1; frontier.length && d <= (opts.maxLevels ?? 8) && level.size < opts.seedCount; d++) {
      const next: string[] = [];
      // A level is always finished: ranking needs every candidate at that distance, and reaching an entry point
      // only parses its handler (its flow is analyzed later, if picked or opened).
      for (const op of frontier) {
        for (const caller of this.loadCallers(op)) {
          if (isEntry(caller)) {
            if (!level.has(caller)) level.set(caller, d);
          } else if (!visited.has(caller)) {
            visited.add(caller);
            next.push(caller);
          }
        }
      }
      frontier = next;
    }

    const words = keywords(`${this.source.title ?? ''} ${this.intent ?? ''}`);
    const label = (id: string) => (this.head.snapshot.entryPoints[id] ?? this.base!.snapshot.entryPoints[id]).label;
    const hinted = (id: string) => opts.seedHints?.some((h) => id === h || label(id).toLowerCase().includes(h.toLowerCase()));
    const scored = [...level.entries()].map(([id, d]) => {
      const hits = [...keywords(label(id))].filter((w) => [...words].some((k) => k.startsWith(w) || w.startsWith(k)));
      const reasons: string[] = [];
      let score = -d;
      if (hinted(id)) { score += 100; reasons.push('picked for this review'); }
      if (d === 0) { score += 4; reasons.push(this.head.snapshot.entryPoints[id] && !this.base?.snapshot.entryPoints[id] ? 'added by this change' : 'its handler changed'); }
      if (hits.length) { score += 2 * Math.min(hits.length, 3); reasons.push(`matches the PR: ${hits.join(', ')}`); }
      if (d > 0) reasons.push(d === 1 ? 'calls the changed code directly' : `${d} calls away from the change`);
      return { id, score, reason: reasons.join('; ') };
    });
    scored.sort((a, b) => b.score - a.score || label(a.id).localeCompare(label(b.id)));
    // Hinted entry points not reached by the search are analyzed too (the agent knows something we don't).
    const extra = (opts.seedHints ?? []).flatMap((h) =>
      Object.keys(this.head.snapshot.entryPoints).filter((id) => (id === h || label(id).toLowerCase().includes(h.toLowerCase())) && !level.has(id)),
    );
    this.seeds = [...scored.slice(0, opts.seedCount), ...extra.map((id) => ({ id, reason: 'picked for this review', score: 0 }))]
      .map(({ id, reason }) => ({ id, reason }));
    for (const s of this.seeds) this.ensure(s.id, true);
  }

  /** One level of callers, analyzed shallowly on both revisions. */
  private loadCallers(opId: string): string[] {
    const ids = new Set([...this.head.callersOf(opId), ...(this.base?.callersOf(opId) ?? [])]);
    for (const id of ids) this.ensure(id, false);
    this.callersLoaded.add(opId);
    return [...ids];
  }

  /** Every caller up to the entry points ("all entry points" in the zoom-out view). Still shallow. */
  private loadReach(opId: string): void {
    const queue = [opId];
    const seen = new Set(queue);
    while (queue.length) {
      for (const c of this.loadCallers(queue.shift()!)) {
        if (!seen.has(c) && !this.head.snapshot.entryPoints[c] && !this.base?.snapshot.entryPoints[c]) {
          seen.add(c);
          queue.push(c);
        }
      }
    }
  }

  /** Analyze a scope on both revisions, then make sure both know the same operations (exact change status). */
  private ensure(id: string, deep: boolean): void {
    for (const x of this.sides()) {
      if (x.snapshot.entryPoints[id]) x.ensureEntry(id, deep);
      else x.ensureOp(id, deep);
    }
    for (let changed = true; changed && this.base; ) {
      changed = false;
      for (const [a, b] of [[this.head, this.base], [this.base, this.head]] as const) {
        for (const opId of Object.keys(a.snapshot.operations)) {
          if (!b.snapshot.operations[opId] && b.ensureOp(opId, a.deep.has(opId))) changed = true;
          else if (a.deep.has(opId) && !b.deep.has(opId) && b.snapshot.operations[opId]) { b.ensureOp(opId, true); changed = true; }
        }
        for (const entryId of Object.keys(a.snapshot.scopes)) {
          if (a.snapshot.entryPoints[entryId] && b.snapshot.entryPoints[entryId] && !b.snapshot.scopes[entryId]) {
            b.ensureEntry(entryId, a.deep.has(entryId));
            changed = true;
          }
        }
      }
    }
  }

  private sides(): Extractor[] {
    return this.base ? [this.head, this.base] : [this.head];
  }

  private timed(fn: () => void): void {
    const t = performance.now();
    fn();
    this.ms += performance.now() - t;
  }
}

const STOP = new Set(['with', 'from', 'that', 'this', 'into', 'over', 'when', 'make', 'data', 'user', 'users', 'send', 'adds', 'only', 'have', 'instead']);

function keywords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.replace(/s$/, '')));
}

function abs(repo: string, rel: string): string {
  return join(repo, rel).replace(/\\/g, '/');
}
