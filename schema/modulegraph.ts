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
  /** Side effects the module declares in its contract (`@effect` tags). */
  declaredEffects: Effect[];
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
  /** Line diff of this operation (base vs head), when changed. */
  diff?: DiffLine[];
  source: string;
}

export interface DiffLine {
  t: '+' | '-' | ' ';
  text: string;
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
}

export interface Scope {
  id: string;
  params: Param[];
  returns?: TypeShape;
  steps: Step[];
  edges: Edge[];
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
