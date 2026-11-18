import { join } from 'node:path';
import type { AnalysisIssue, Example, ModuleGraph, Source } from '../../schema/modulegraph.ts';
import type { RevisionAnalysis } from './analyzers/types.ts';
import { compare } from './compare.ts';
import type { Config } from './config.ts';
import { changeIssues, revisionIssues } from './coverage.ts';
import { withInvariants } from './invariants.ts';
import { describe } from './describe.ts';
import { hunks, type RawDiff } from './git.ts';
import { architectureFindings, changeFindings, markNew, modulesOfFile, reviewSummary } from './rules.ts';

export interface LazyOptions {
  /** How many entry points to analyze up front. */
  seedCount: number;
  /** Entry point ids or label fragments to analyze up front (an agent's pick); overrides the ranking. */
  seedHints?: string[];
  /** Upward search stops after this many caller levels even if fewer entry points were found. */
  maxLevels?: number;
}

export type ExpandAction = 'callers' | 'reach' | 'entry' | 'op';

/** The code as it is now, for `refresh`. A side that did not change is passed as the same object. */
export interface NextRevisions {
  head: RevisionAnalysis;
  base?: RevisionAnalysis;
  diff: RawDiff | undefined;
  source: Source;
  intent?: string;
}

/**
 * Builds the review graph on demand instead of all at once.
 *
 * Works with any backend that implements the lazy half of `RevisionAnalysis` (the TypeScript one does).
 *
 * 1. Map changed lines to the operations/entry points that contain them (directly, or through inlined helpers
 *    and changed types), using the backend's reference index. Analyze those, downward.
 * 2. Walk callers upward level by level, analyzing each caller's own scope only, until `seedCount` entry points
 *    are reached. Rank them against the PR (changed entry points, words from the title/intent, distance) and
 *    analyze the best ones fully.
 * 3. Everything else stays unanalyzed until the reviewer asks: callers of a node, all entry points of a change,
 *    a flow, or a drill-in. Both revisions are always analyzed to the same extent, so change status stays exact.
 */
export class LazySession {
  private head: RevisionAnalysis;
  /** The head revision's analysis as it stands (it is replaced on refresh). */
  get headAnalysis(): RevisionAnalysis {
    return this.head;
  }
  private base?: RevisionAnalysis;
  private callersLoaded = new Set<string>();
  private seeds: { id: string; reason: string }[] = [];
  private ms = 0;
  private opts: LazyOptions = { seedCount: 2 };
  /** What the reviewer opened (and the seeds), replayed after a refresh so the graph keeps what was explored. */
  private explored: { action: ExpandAction; id: string }[] = [];
  private initialized = new WeakSet<RevisionAnalysis>();
  /** Changed code no flow covers: depends only on the code and the diff, so found once per (re)start. */
  private unmapped: AnalysisIssue[] = [];

  constructor(
    head: RevisionAnalysis,
    base: RevisionAnalysis | undefined,
    private repo: string,
    private config: Config,
    private diff: RawDiff | undefined,
    private source: Source,
    private intent: string | undefined,
    public examples: Record<string, Example[]> = {},
    private generator = 'modulegraph-analyzer',
  ) {
    this.head = head;
    this.base = base;
  }

  init(opts: LazyOptions): void {
    this.opts = opts;
    this.timed(() => this.start());
  }

  /**
   * The code changed (new commits, edits in the working tree): analyze it again, keeping what still holds. A side
   * passed as the same object keeps its analysis (usually the base: the PR's base doesn't move while you review).
   * The new side is analyzed to the same extent as before: the changed code, the seeds, and everything the reviewer
   * opened, so the graph looks the same apart from what the edit changed.
   */
  refresh(next: NextRevisions): void {
    this.head = next.head;
    this.base = next.base;
    this.diff = next.diff;
    this.source = next.source;
    this.intent = next.intent;
    // Operations whose callers were listed must list them again: a new call may have appeared on the new side.
    const callers = [...this.callersLoaded];
    const seeds = this.seeds.map((s) => s.id);
    this.callersLoaded = new Set();
    this.ms = 0;
    this.timed(() => {
      this.start();
      for (const id of seeds) this.ensure(id, true);
      for (const { action, id } of this.explored) this.replay(action, id);
      for (const id of callers) this.loadCallers(id);
    });
  }

  private start(): void {
    for (const x of this.sides()) {
      if (this.initialized.has(x)) continue;
      x.init();
      x.listEntryPoints();
      this.initialized.add(x);
    }
    const changed = this.changedScopes();
    for (const id of changed) this.ensure(id, true);
    // Who calls each changed operation: grouping folds an operation into the change that calls it only when its
    // callers are known, and the seed search below may stop before it gets to them (new entry points fill it).
    const isEntry = (id: string) => !!(this.head.snapshot.entryPoints[id] ?? this.base?.snapshot.entryPoints[id]);
    for (const id of changed) if (!isEntry(id)) this.loadCallers(id);
    this.pickSeeds(changed, this.opts);
    this.unmapped = changeIssues(this.head, this.base, this.diff, this.repo);
  }

  /** Every module method, for recording example calls (cheap: no analysis). */
  exampleTargets() {
    return this.head.operationTargets();
  }

  expand(action: ExpandAction, id: string): void {
    this.explored.push({ action, id });
    this.timed(() => this.replay(action, id));
  }

  private replay(action: ExpandAction, id: string): void {
    if (action === 'callers') this.loadCallers(id);
    else if (action === 'reach') this.loadReach(id);
    else this.ensure(id, true);
  }

  graph(): ModuleGraph {
    for (const x of this.sides()) x.computeTransitiveEffects();
    const head = this.head.snapshot;
    const base = this.base?.snapshot;
    const g = withInvariants(describe(compare(head, base), this.config));
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
      file.modules = modulesOfFile(g, file.path);
    }
    let findings = architectureFindings(g, this.config);
    if (base) {
      findings = markNew(findings, architectureFindings(compare(base), this.config));
      findings.push(...changeFindings(g, this.diff!, this.config, this.intent));
    }
    const entries = Object.values(g.entryPoints);
    const incomplete = [...revisionIssues(this.head, this.base), ...this.unmapped];
    return {
      schema: 'modulegraph/v1',
      service: this.config.service,
      generatedAt: new Date().toISOString(),
      generator: `${this.generator}, lazy`,
      source: this.source,
      ...g,
      findings,
      review: reviewSummary(g, this.diff),
      ...(incomplete.length ? { incomplete } : {}),
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
    // How much of the change a flow exercises: changed operations reachable from it through what is analyzed so far.
    const changedSet = new Set(changed);
    const changedReached = (id: string): number => {
      const seen = new Set<string>();
      const found = new Set<string>();
      const stack = [...(this.head.snapshot.scopes[id] ?? this.base?.snapshot.scopes[id])?.steps.flatMap((s) => (s.target ? [s.target] : [])) ?? []];
      while (stack.length) {
        const op = stack.pop()!;
        if (seen.has(op)) continue;
        seen.add(op);
        if (changedSet.has(op)) found.add(op);
        stack.push(...(this.head.snapshot.operations[op] ?? this.base?.snapshot.operations[op])?.calls ?? []);
      }
      return found.size;
    };
    const scored = [...level.entries()].map(([id, d]) => {
      const hits = [...keywords(label(id))].filter((w) => [...words].some((k) => k.startsWith(w) || w.startsWith(k)));
      const reasons: string[] = [];
      let score = -d;
      if (hinted(id)) { score += 100; reasons.push('picked for this review'); }
      if (d === 0) { score += 4; reasons.push(this.head.snapshot.entryPoints[id] && !this.base?.snapshot.entryPoints[id] ? 'added by this change' : 'its handler or a type it uses changed'); }
      if (hits.length) { score += 2 * Math.min(hits.length, 3); reasons.push(`matches the PR: ${hits.join(', ')}`); }
      const reached = changedReached(id);
      if (reached > 1) { score += Math.min(reached - 1, 3); reasons.push(`reaches ${reached} changed operations`); }
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
        // A scope that inlines another operation of its class (`resolveHold` → `this.cancel`) diffs that code against
        // the other revision's copy, so that revision needs it analyzed too.
        const known = new Set(b.knownOperations());
        for (const parts of Object.values(a.snapshot.parts)) {
          for (const p of parts) {
            if (p.role === 'helper' && known.has(p.name) && !b.snapshot.operations[p.name] && b.ensureOp(p.name, false)) changed = true;
          }
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

  private sides(): RevisionAnalysis[] {
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
