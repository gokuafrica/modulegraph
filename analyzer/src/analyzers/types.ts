/**
 * The contract between modulegraph and its language backends.
 *
 * Everything after extraction (base vs head comparison, rules, the facts brief, lazy expansion, the UI) only sees
 * a `Snapshot` per revision. A backend turns one revision of a codebase into that snapshot. To support another
 * language, implement `LanguageAnalyzer` and register it in ./index.ts. Nothing else in modulegraph changes.
 */
import type { CodeChange, EntryPoint, ModuleInfo, Operation, Scope } from '../../../schema/modulegraph.ts';
import type { Config } from '../config.ts';

export interface Snapshot {
  modules: Record<string, ModuleInfo>;
  operations: Record<string, Operation>;
  entryPoints: Record<string, EntryPoint>;
  scopes: Record<string, Scope>;
  /** Normalised source of everything that defines behaviour, per module/op/entry id. Equal = unchanged. */
  fingerprints: Record<string, string>;
  /** Functions behind each scope (its own function first, then inlined helpers), for per-function diffs. */
  parts: Record<string, Part[]>;
}

export interface Part {
  name: string;
  role: CodeChange['role'];
  file: string;
  line: number;
  text: string;
}

/** What the example recorder needs to wrap an operation at runtime. */
export interface OperationTarget {
  opId: string;
  file: string;
  className: string;
  method: string;
  params: string[];
}

/**
 * One revision of the code, analyzed by a backend. Full analysis calls `run()`. Lazy analysis calls `init()` and
 * `listEntryPoints()`, then grows the snapshot with `ensureOp` / `ensureEntry` / `callersOf` from the changed lines
 * (`scopesForLines`). A backend that can't do lazy analysis can implement the lazy methods by running everything.
 */
export interface RevisionAnalysis {
  readonly snapshot: Snapshot;
  /** Scopes analyzed downward completely (every callee analyzed too). */
  readonly deep: Set<string>;
  run(): Snapshot;
  init(): void;
  listEntryPoints(): void;
  ensureOp(opId: string, deep?: boolean): boolean;
  ensureEntry(id: string, deep?: boolean): boolean;
  callersOf(opId: string): string[];
  scopesForLines(absPath: string, ranges: [number, number][]): string[];
  knownOperations(): string[];
  operationTargets(): OperationTarget[];
  computeTransitiveEffects(): void;
}

/** A framework or library the backend recognised, and why (shown in the report and the brief). */
export interface DetectedFramework {
  id: string;
  name: string;
  reason: string;
}

export interface OpenInput {
  repo: string;
  projectDir: string;
  config: Config;
  /** Source files of the revision, keyed by absolute path. Undefined = read the working tree. */
  files?: Map<string, string>;
}

export interface LanguageAnalyzer {
  /** e.g. "typescript". Selectable with `--analyzer <id>` or `"analyzer"` in the profile. */
  id: string;
  language: string;
  /** Why this backend fits the project, or undefined when it doesn't. */
  detect(projectDir: string): string | undefined;
  /** Repo paths this backend reads from git for a revision. */
  sourceFile(path: string): boolean;
  /** Frameworks found in the project, after the profile's `frameworks` override. */
  frameworks(projectDir: string, config: Config): DetectedFramework[];
  open(input: OpenInput): RevisionAnalysis;
  /** Shown in the graph's `generator` field. */
  generator: string;
}
