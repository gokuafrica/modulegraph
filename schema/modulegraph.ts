/**
 * modulegraph/v1: the contract between producers (static analyzer, LLM agent) and the review UI.
 * JSON Schema equivalent: modulegraph.schema.json (kept in sync by `npm run schema` in analyzer/).
 */

export type EffectKind = 'db.read' | 'db.write' | 'outbox' | 'kafka' | 'http';
export type ChangeStatus = 'added' | 'modified' | 'removed' | 'unchanged';
export type EntryKind = 'api' | 'grpc' | 'consumer' | 'cron';
export type Risk = 'high' | 'medium' | 'low' | 'none';

export interface Effect {
  kind: EffectKind;
  /** Table name, outbox event type, Kafka topic or external service name. */
  target: string;
  file?: string;
  line?: number;
}

export interface Param {
  name: string;
  type: string;
}

export interface TypeShape {
  type: string;
  /** One level of fields when the type is an object. */
  fields?: Param[];
}

export interface ModuleGraph {
  schema: 'modulegraph/v1';
  service: string;
  generatedAt: string;
  generator: string;
  source: Source;
  modules: Record<string, ModuleInfo>;
  operations: Record<string, Operation>;
  entryPoints: Record<string, EntryPoint>;
  /** Keyed by operation id or entry point id. */
  scopes: Record<string, Scope>;
  findings: Finding[];
  review: ReviewSummary;
  /** Present when the graph was built lazily: only what the review needed so far. */
  lazy?: LazyInfo;
}

/**
 * Lazy analysis: start at the changed code, walk callers up only until a few relevant entry points are found,
 * analyze those fully, and leave the rest for the reviewer to expand on demand.
 */
export interface LazyInfo {
  /** Where the live analysis server answers expand requests, relative to the UI ("/api"). Absent = static file. */
  api?: string;
  /** Entry points analyzed up front, and why each was picked. */
  seeds: { id: string; reason: string }[];
  stats: {
    entryPointsKnown: number;
    /** Flow fully analyzed (handler and everything below it). */
    entryPointsAnalyzed: number;
    /** Known to reach the change, flow not analyzed yet. */
    entryPointsReached: number;
    operationsKnown: number;
    operationsAnalyzed: number;
    /** Milliseconds spent on analysis so far (initial + expansions). */
    ms: number;
  };
}

export interface Source {
  mode: 'snapshot' | 'uncommitted' | 'branch' | 'pr';
  repo: string;
  project: string;
  base?: string;
  head?: string;
  title?: string;
  /** Stated intent (PR description). Used to flag undisclosed side effects. */
  intent?: string;
  /** Where the intent came from: the --intent flag, the PR description, or the branch's commit messages. */
  intentSource?: 'flag' | 'pr' | 'commits';
  /** Scenario that was run against the head revision to capture example inputs/outputs. */
  examples?: { scenario: string; operationsCovered: number };
  files: FileChange[];
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: number;
  removed: number;
  /** Modules whose code lives in this file. Empty = change not attributed to any module. */
  modules: string[];
}

export interface ModuleInfo {
  id: string;
  /** Display name, e.g. "BirthInfo". */
  name: string;
  className: string;
  file: string;
  line: number;
  summary: string;
  owner?: string;
  /** Side effects declared for the module (external config, or opt-in `@effect` tags). Empty when none are declared. */
  declaredEffects: Effect[];
  /** Where declarations came from. Absent = nothing declared, so the undeclared-effect rule doesn't apply. */
  contractSource?: 'config' | 'tags';
  operations: string[];
  change: ChangeStatus;
}

export interface Operation {
  id: string;
  moduleId: string;
  name: string;
  file: string;
  line: number;
  endLine: number;
  params: Param[];
  returns: TypeShape;
  /** Effects performed by this operation itself (incl. inlined non-module helpers). */
  directEffects: Effect[];
  /** Direct + everything reachable through called operations. */
  effects: Effect[];
  /** Operation ids called directly. */
  calls: string[];
  change: ChangeStatus;
  /** True when this op or anything it reaches changed. Tells the reviewer to drill in. */
  containsChanges: boolean;
  delta?: ContractDelta;
  /** Line diff of this operation's own method (base vs head), when changed. */
  diff?: DiffLine[];
  /** Every changed function behind this operation: its own method plus inlined helpers, possibly in other files. */
  changes?: CodeChange[];
  /** Real calls recorded while running the scenario on the head revision (up to 3 distinct). */
  examples?: Example[];
  source: string;
  /** Lazy analyses only: whether callers (up) and callees (down) of this operation have been analyzed. */
  lazy?: { callersLoaded: boolean; calleesLoaded: boolean };
}

export interface Example {
  /** Argument values keyed by parameter name. */
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
}

export interface DiffLine {
  t: '+' | '-' | ' ';
  text: string;
  /** Line number in the base file (context and removed lines). */
  a?: number;
  /** Line number in the head file (context and added lines). */
  b?: number;
}

/** One changed function inside a scope. Large changes are reviewed function by function, not as one blob. */
export interface CodeChange {
  /** "resolve", or the inlined helper, e.g. "riskTier" or "KycModule.persist". */
  name: string;
  role: 'operation' | 'handler' | 'helper';
  file: string;
  /** First line of the function (head; base when removed). */
  line: number;
  status: 'added' | 'removed' | 'modified';
  added: number;
  removed: number;
  diff: DiffLine[];
}

export interface ContractDelta {
  risk: Risk;
  params?: { before: Param[]; after: Param[] };
  returns?: { before: TypeShape; after: TypeShape };
  effectsAdded: Effect[];
  effectsRemoved: Effect[];
  callsAdded: string[];
  callsRemoved: string[];
  implementationOnly: boolean;
}

export interface EntryPoint {
  id: string;
  kind: EntryKind;
  /** e.g. "GET /v1/users/:userId/profile", "topic user.deleted", "cron kyc-nightly-rescreen". */
  label: string;
  /** Read-only by protocol semantics (HTTP GET, gRPC Get*). Used by the read-path-writes rule. */
  readOnly: boolean;
  file: string;
  line: number;
  effects: Effect[];
  change: ChangeStatus;
  containsChanges: boolean;
  effectsAdded?: Effect[];
  effectsRemoved?: Effect[];
  /** Changed functions behind the handler (handler + inlined helpers). */
  changes?: CodeChange[];
  /** Lazy analyses only. listed: only its registration is known; reached: known to reach the change; full: flow analyzed. */
  analysis?: 'listed' | 'reached' | 'full';
}

export interface Scope {
  id: string;
  params: Param[];
  returns?: TypeShape;
  steps: Step[];
  edges: Edge[];
  /** Steps the base revision had that the head no longer has (drawn as ghosts). Ids are prefixed "rm:". */
  removedSteps?: Step[];
  /** Base edges that touched a removed step, mapped onto head step ids. */
  removedEdges?: Edge[];
}

export interface Step {
  id: string;
  kind: 'call' | 'effect';
  /** Operation id, for kind = call. */
  target?: string;
  effect?: Effect;
  line: number;
  file: string;
  /** Guard under which the step runs, e.g. "if (consented)" or "unless (consented)". */
  condition?: string;
  loop?: boolean;
  /** Non-module helper the step was inlined from. */
  via?: string;
  /** Set when comparing with a base: the step is new in this scope, or (in removedSteps) gone. */
  delta?: 'added' | 'removed';
  /** The step's guard on the base revision, when it changed ("" = had none). */
  conditionBefore?: string;
}

export interface Edge {
  /** Step id, or "entry". */
  from: string;
  /** Step id, or "exit". */
  to: string;
  kind: 'data' | 'control';
  label?: string;
}

export interface Finding {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  subject?: { type: 'module' | 'operation' | 'entry' | 'file'; id: string };
  /** Other entities the finding applies to (e.g. every read-only entry point that now writes). */
  related?: { type: 'module' | 'operation' | 'entry' | 'file'; id: string }[];
  /** True when the finding did not exist on the base revision. */
  isNew: boolean;
  hint?: string;
}

export interface ReviewSummary {
  changedModules: string[];
  changedOperations: string[];
  /** Changed ops sorted by contract risk: what the reviewer should look at first. */
  queue: { operation: string; risk: Risk; reason: string; reach: number }[];
  /** Owners whose modules' contracts changed. */
  reviewers: string[];
  stats: { files: number; linesAdded: number; linesRemoved: number; contractChanges: number; entryPointsAffected: number };
}
