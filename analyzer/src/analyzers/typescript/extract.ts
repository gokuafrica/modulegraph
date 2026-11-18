import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, dirname, join, relative } from 'node:path';
import {
  Node,
  Project,
  Scope as MemberScope,
  SyntaxKind,
  TypeFormatFlags,
  type ArrowFunction,
  type CallExpression,
  type ClassDeclaration,
  type Decorator,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type NewExpression,
  type SourceFile,
  type Type,
} from 'ts-morph';
import type { AnalysisIssue, Edge, Effect, EntryPoint, Exit, ExplainEntry, Gap, GapReason, Param, PipelineItem, Scope, Step, TypeShape } from '../../../../schema/modulegraph.ts';
import type { CallbackRule, CallMatch, Config, DecoratorEntryRule, DocDecoratorRule, EntryRule, RegistryEntryRule, ResponseRule, SinkRule } from '../../config.ts';
import { argvScripts, CONSUMER_PACKAGES, EFFECT_NAME, isEffectMethod, isNetworkCall, networkVia, readPackageJson, registryKind, sinkKind, suggestedTarget, wraps } from './coverage-hints.ts';
import { frameworks as allFrameworks } from './frameworks/index.ts';
import { pipelineKey } from '../../compare.ts';
import { dedupeEffects } from '../../effects.ts';
import type { OperationTarget, Part, RevisionAnalysis, Snapshot } from '../types.ts';
import type { CallSite, Framework, FrameworkHooks, HookContext, PipelineSpec, TransactionApi } from './frameworks/types.ts';

export type { Part, Snapshot } from '../types.ts';

type Fn = MethodDeclaration | FunctionDeclaration | ArrowFunction | FunctionExpression;
type Invocation = CallExpression | NewExpression;
/** producer step id (or "entry") -> labels of the variables that carried the value */
type Prod = Map<string, Set<string>>;

type Resolved =
  | { kind: 'op'; opId: string }
  | { kind: 'sink'; effect: Effect }
  | { kind: 'response'; arg?: Node }
  | { kind: 'inline'; fn: Fn; name: string }
  /** A bus call (CQRS) that runs these handlers. */
  | { kind: 'dispatch'; targets: Resolved[] }
  | { kind: 'unknown' };

interface FnResult {
  steps: Step[];
  edges: Edge[];
  returns: Prod;
  parts: Part[];
  /** Arguments of response calls (`res.json(x)`): what the handler returns when it doesn't `return`. */
  responses: Node[];
  /** What it returns, as far as the code shows (`Val`). */
  vals: Val[];
}

/** A resolved call: the shared CallSite plus what the extractor needs internally. */
interface Site extends CallSite {
  decl: Node;
  /** Module class whose method this is (after following an interface to its single implementation). */
  cls?: ClassDeclaration;
}

/** Where an entry point's handler is: the registration call (or decorated method) and the handler function. */
interface EntrySite {
  at: Node;
  handler: Fn;
  /** The class the handler runs as, when it inherits the method from a base class: `this.x()` means its `x`. */
  thisClass?: ClassDeclaration;
  /** Methods the framework calls before the handler, in order (a job's `onModuleInit`, then `onApplicationBootstrap`). */
  before?: { method: MethodDeclaration; cls: ClassDeclaration }[];
}

/** One handler class a profile registry rule makes an entry point. */
interface RegistryEntry {
  rule: RegistryEntryRule;
  label: string;
  at: Node;
  cls: ClassDeclaration;
  /** Every method the framework calls for this entry point, in order: one entry point, not one per method. */
  chain: { method: MethodDeclaration; cls: ClassDeclaration }[];
}

/** Config rules plus every enabled framework adapter's rules, merged once per revision. */
interface Rules {
  sinks: SinkRule[];
  entries: EntryRule[];
  decorators: DecoratorEntryRule[];
  responses: ResponseRule[];
  moduleDecorators: Set<string>;
  notModuleDecorators: Set<string>;
  notModuleImplements: Set<string>;
  ignoreMethods: Set<string>;
  hooks: FrameworkHooks[];
  /** Description decorators: on handlers and methods, and on DTO fields. */
  docs: DocDecoratorRule[];
  fieldDocs: DocDecoratorRule[];
  /** In-house registrations (handler maps, base classes, modules picked by a command-line argument). */
  registries: RegistryEntryRule[];
  /** Callee names that can register an entry point (cheap filter before type resolution). */
  entryNames: Set<string>;
  /** Callee names that can dispatch to handlers (CQRS buses), for finding a handler's callers. */
  dispatchNames: Set<string>;
  /** Libraries' transaction APIs (handles, begin and commit, callbacks run in a transaction). */
  transactions: TransactionApi[];
  /** Library calls that run the function they are given in place (adapters', then the profile's `callbacks`). */
  callbacks: CallbackRule[];
}

const MAX_TYPE = 110;
/** Handler method names, best first: families, not words one service happens to use. */
const HANDLER_FAMILIES = [/^handle/, /^(process|consume)/, /^on[A-Z]/, /^(execute|run)$/];
/** Framework lifecycle hooks: called by the framework at start and stop, never a message or job handler. */
const LIFECYCLE_HOOK = /^on(Module|Application)(Init|Bootstrap|Destroy|Shutdown)$|^beforeApplicationShutdown$/;
/** The order a framework calls start hooks in (Nest: every `onModuleInit`, then every `onApplicationBootstrap`). */
const START_ORDER = ['onModuleInit', 'onApplicationBootstrap'];

/** Library methods that run the function they are given right there, once per item: its steps are in a loop. */
const ARRAY_CALLBACKS = new Set(['map', 'forEach', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap', 'sort', 'toSorted']);
/** A promise's continuations: they run after it, in the same flow. */
const PROMISE_CALLBACKS = new Set(['then', 'catch', 'finally']);

type Guard = { condition?: string; loop?: boolean };

/** How a function is run: the scope it closes over, the values of its arguments, an enclosing `@Transactional`. */
interface Invoke {
  env?: Env;
  args?: Val[][];
  ambient?: string;
}

/** A transaction the analyzed code opens on a handle (a query runner; the manager a transaction callback is given). */
interface Tx {
  /** The data source it is opened on (`@InjectDataSource('orders')` → orders), or the callback API (`dataSource.transaction`). */
  name: string;
  /** A callback transaction's name is its API, used as it is. */
  fixed?: boolean;
  begun: boolean;
  /** When it began and committed (call count): transactions open at the same time commit separately. */
  from: number;
  to?: number;
}

/**
 * What the analysis knows a value is, as far as the code shows it: a function (with the scope it closes over), a
 * transaction's handle (or what was got from it: `runner.manager`, a repository from it), a field of the class (a
 * data source, by the name it is injected with), an object or a list of these, or one implementation of an interface
 * the module wiring lists.
 */
type Val =
  | { k: 'fn'; fn: Fn; env?: Env }
  | { k: 'handle'; tx: Tx; result?: boolean }
  | { k: 'source'; node: Node }
  | { k: 'obj'; props: Map<string, Val[]> }
  | { k: 'arr'; items: Val[][] }
  | { k: 'impl'; cls: ClassDeclaration };

/** Variables in scope: where each value came from (`Prod`, for data arrows) and what it is (`Val`). Closures chain. */
class Env {
  private readonly prods = new Map<string, Prod>();
  private readonly vals = new Map<string, Val[]>();
  constructor(private readonly parent?: Env) {}
  has(name: string): boolean {
    return this.prods.has(name) || !!this.parent?.has(name);
  }
  prod(name: string): Prod | undefined {
    return this.prods.has(name) ? this.prods.get(name) : this.parent?.prod(name);
  }
  val(name: string): Val[] {
    return this.vals.has(name) ? this.vals.get(name)! : this.parent?.val(name) ?? [];
  }
  define(name: string, prod: Prod, vals: Val[]): void {
    this.prods.set(name, prod);
    this.vals.set(name, vals);
  }
  assign(name: string, prod: Prod, vals: Val[]): void {
    let e: Env | undefined = this;
    while (e && !e.prods.has(name)) e = e.parent;
    (e ?? this).define(name, prod, vals);
  }
}

/**
 * What one scope's analysis did with each call (`--explain`), the transactions it saw opened, and which steps go
 * through their handles. Dispositions: `step`, `inlined` (a project helper whose steps are the caller's), `external`
 * (a library call no adapter or rule makes I/O), `followed` (a function value or an interface call, to the code it
 * runs) and `gap` (it can't be followed: why, from a closed list).
 */
class Trace {
  clock = 0;
  readonly txs: Tx[] = [];
  /** step id → the transactions it goes through */
  readonly stepTx = new Map<string, Tx[]>();
  /** step id → transactions open while it runs that it doesn't go through (a rollback doesn't undo it) */
  readonly outside = new Map<string, Tx[]>();
  /** Function literals handed to a call, and where they were run. */
  readonly handed = new Map<Node, { file: string; line: number; text: string; to: string[] }>();
  private readonly entries = new Map<string, ExplainEntry>();

  note(e: ExplainEntry): void {
    const key = `${e.file}:${e.line}:${e.text}`;
    const prev = this.entries.get(key);
    if (!prev || (e.disposition === 'gap' && prev.disposition !== 'gap')) this.entries.set(key, e);
    else if (prev.disposition === 'followed' && e.to) prev.to = [...new Set([...(prev.to?.split(', ') ?? []), ...e.to.split(', ')])].join(', ');
  }

  /**
   * Names each step's transaction. Transactions open at the same time are separate commits (one can commit and the
   * other fail), so they are named together, never as one: `2 transactions (orders, audit), separate commits`.
   */
  label(steps: Step[]): void {
    const used = [...new Set([...this.stepTx.values(), ...this.outside.values()].flat())];
    const overlap = (a: Tx, b: Tx) => a.from < (b.to ?? Infinity) && b.from < (a.to ?? Infinity);
    const groups: Tx[][] = [];
    for (const t of used) {
      const hit = groups.filter((g) => g.some((u) => overlap(t, u)));
      for (const h of hit) groups.splice(groups.indexOf(h), 1);
      groups.push([t, ...hit.flat()]);
    }
    const names = new Map<Tx, string>();
    const seen = new Map<string, number>();
    for (const g of groups.sort((a, b) => Math.min(...a.map((t) => t.from)) - Math.min(...b.map((t) => t.from)))) {
      g.sort((a, b) => a.from - b.from);
      let name = g.length === 1 ? (g[0].fixed ? g[0].name : `${g[0].name} transaction`) : `${g.length} transactions (${g.map((t) => t.name).join(', ')}), separate commits`;
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      if (n > 1) name = `${name} #${n}`;
      for (const t of g) names.set(t, name);
    }
    for (const s of steps) {
      const through = this.stepTx.get(s.id);
      if (through) s.transaction = names.get(through[0]);
      else if (!s.transaction && this.outside.has(s.id)) s.outsideTransaction = names.get(this.outside.get(s.id)![0]);
    }
  }

  finish(): { explain: ExplainEntry[]; gaps: Gap[] } {
    for (const h of this.handed.values()) {
      if (h.to.length) this.note({ file: h.file, line: h.line, text: h.text, disposition: 'followed', to: [...new Set(h.to)].join(', ') });
      else this.note({ file: h.file, line: h.line, text: h.text, disposition: 'gap', reason: 'function-value' });
    }
    const explain = [...this.entries.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const gaps = [...new Map(explain.filter((e) => e.disposition === 'gap').map((e) => [`${e.file}:${e.line}:${e.reason}`, { file: e.file, line: e.line, reason: e.reason! }])).values()];
    return { explain, gaps };
  }
}

/**
 * A read that locks what it reads: TypeORM `find…({ lock: { mode: 'pessimistic_write' } })`, a query builder's
 * `.setLock('pessimistic_write')`, SQL `… FOR UPDATE`. Undefined when it locks nothing.
 */
function lockOf(call: Invocation): string | undefined {
  const mode = (m: string) => (/write|update/i.test(m) ? 'for update' : /read|share/i.test(m) ? 'for share' : /optimistic/i.test(m) ? undefined : `(${m})`);
  for (const arg of call.getArguments()) {
    if (!Node.isObjectLiteralExpression(arg)) continue;
    const lock = arg.getProperty('lock');
    const value = lock && Node.isPropertyAssignment(lock) ? lock.getInitializer() : undefined;
    const m = value && Node.isObjectLiteralExpression(value) ? value.getProperty('mode') : undefined;
    const text = m && Node.isPropertyAssignment(m) ? m.getInitializer()?.getText().replace(/['"`]/g, '') : undefined;
    if (text) return mode(text);
  }
  for (let cur: Node | undefined = call.getExpression(); cur && (Node.isPropertyAccessExpression(cur) || Node.isCallExpression(cur)); cur = cur.getExpression()) {
    if (Node.isCallExpression(cur) && calleeName(cur) === 'setLock') {
      const first = cur.getArguments()[0];
      if (first) return mode(first.getText().replace(/['"`]/g, ''));
    }
  }
  const sql = call.getArguments()[0];
  if (sql && (Node.isStringLiteral(sql) || Node.isNoSubstitutionTemplateLiteral(sql) || Node.isTemplateExpression(sql)) && /\bfor\s+(no\s+key\s+)?update\b/i.test(sql.getText())) return 'for update';
  return undefined;
}

/** Binds a name or a destructuring pattern (`{ runner, jobs }`, `[a, b]`) to the parts of `vals` it takes. */
function destructure(name: Node, vals: Val[], define: (name: string, vals: Val[]) => void): void {
  if (Node.isIdentifier(name)) return define(name.getText(), vals);
  if (Node.isObjectBindingPattern(name)) {
    for (const el of name.getElements()) {
      const prop = el.getPropertyNameNode()?.getText() ?? el.getNameNode().getText();
      destructure(el.getNameNode(), el.getDotDotDotToken() ? vals : member(vals, prop), define);
    }
  } else if (Node.isArrayBindingPattern(name)) {
    name.getElements().forEach((el, i) => {
      if (Node.isBindingElement(el)) destructure(el.getNameNode(), vals.flatMap((v) => (v.k === 'arr' ? v.items[i] ?? v.items.flat() : [])), define);
    });
  }
}

/** `x.name` of these values: an object's property; anything got from a handle works on its connection too. */
function member(vals: Val[], name: string): Val[] {
  return vals.flatMap((v): Val[] => (v.k === 'obj' ? v.props.get(name) ?? [] : v.k === 'handle' ? [{ k: 'handle', tx: v.tx }] : []));
}

/** Transactions whose handles these values are or hold. */
function handlesIn(vals: Val[], depth = 0): Tx[] {
  if (depth > 4) return [];
  const out = new Set<Tx>();
  for (const v of vals) {
    if (v.k === 'handle') out.add(v.tx);
    else if (v.k === 'obj') for (const x of v.props.values()) handlesIn(x, depth + 1).forEach((t) => out.add(t));
    else if (v.k === 'arr') for (const x of v.items) handlesIn(x, depth + 1).forEach((t) => out.add(t));
  }
  return [...out];
}

/** What an array method gives back: its items (`find`, `at`), a list of them (`filter`, `slice`), or the callback's results (`map`). */
function arrayResult(name: string, recv: Val[], results: Val[]): Val[] {
  const arrs = recv.filter((v): v is Extract<Val, { k: 'arr' }> => v.k === 'arr');
  if (!arrs.length) return [];
  if (name === 'map' || name === 'flatMap') return [{ k: 'arr', items: [results] }];
  if (['filter', 'slice', 'sort', 'toSorted', 'reverse', 'concat', 'flat'].includes(name)) return [{ k: 'arr', items: arrs.flatMap((a) => a.items) }];
  if (['find', 'findLast', 'at', 'pop', 'shift'].includes(name)) return arrs.flatMap((a) => a.items.flat());
  return [];
}

/** Function literals among a call's arguments, directly or in an array or object literal argument. */
function literalsIn(args: Node[]): Fn[] {
  const out: Fn[] = [];
  const visit = (n: Node, depth: number) => {
    if (Node.isArrowFunction(n) || Node.isFunctionExpression(n)) out.push(n);
    else if (depth < 3 && Node.isArrayLiteralExpression(n)) n.getElements().forEach((e) => visit(e, depth + 1));
    else if (depth < 3 && Node.isObjectLiteralExpression(n)) for (const p of n.getProperties()) if (Node.isPropertyAssignment(p) && p.getInitializer()) visit(p.getInitializer()!, depth + 1);
  };
  for (const a of args) visit(a, 0);
  return out;
}

/** Code inside a function or class nested in `body`: it runs when that function runs, not here. */
function insideNested(n: Node, body: Node): boolean {
  for (let p = n.getParent(); p && p !== body; p = p.getParent()) {
    if (isFnNode(p) || Node.isClassDeclaration(p) || Node.isClassExpression(p) || Node.isGetAccessorDeclaration(p) || Node.isSetAccessorDeclaration(p) || Node.isConstructorDeclaration(p)) return true;
  }
  return false;
}

export function extract(project: Project, repoRoot: string, projectDir: string, config: Config, frameworks: Framework[] = []): Snapshot {
  return new Extractor(project, repoRoot, projectDir, config, frameworks).run();
}

/**
 * The TypeScript backend: turns code into the graph with the type checker. Two ways to drive it:
 * - `run()`: everything (every operation, every entry point). Simple, and fine for small services.
 * - lazy (`init()` then `ensureOp` / `ensureEntry` / `callersOf` / `scopesForLines`): only what a review needs,
 *   found from the changed lines outwards with the TypeScript reference index. See lazy.ts.
 * What counts as an entry point or a side effect comes from the profile and the framework adapters (./frameworks).
 */
export class Extractor implements RevisionAnalysis {
  private moduleIds = new Map<ClassDeclaration, string>();
  /** Registration of every entry point found so far (lazy mode builds scopes from these on demand). */
  private entrySites = new Map<string, EntrySite>();
  private entryIdCache = new Map<Node, string | undefined>();
  private siteCache = new Map<Node, Site | undefined>();
  private globalVars?: Record<string, string>;
  private callIndex?: Map<string, CallExpression[]>;
  private rules: Rules;
  /** Scopes analyzed downward completely (every callee analyzed too). */
  readonly deep = new Set<string>();
  snapshot: Snapshot = { modules: {}, operations: {}, entryPoints: {}, scopes: {}, fingerprints: {}, parts: {} };
  private stepCounter = 0;
  private currentClass?: ClassDeclaration;
  /** npm packages of the framework adapters in use: when these don't resolve, the analysis is blind. */
  private frameworkPackages: Set<string>;
  /** Request pipeline of each decorated entry point (guards, interceptors, …), as the framework adapters found it. */
  private pipelines = new Map<string, PipelineSpec[]>();
  /** Code that applies a pipeline item, or runs as one (`canActivate`), → the entry points it is in front of. */
  private pipelineAt = new Map<Node, Set<string>>();
  private listed = false;
  /**
   * Registration calls that matched an entry rule but name nothing this analysis can read (a consumer started in a
   * loop over registered handlers, with no topic in sight): not entry points, reported as a coverage sign instead.
   */
  private dynamicEntries = new Map<string, { kind: EntryPoint['kind']; at: string }>();
  private hookMemo = new Map<string, unknown>();
  /** Class names more than one module has. */
  private sharedNames = new Set<string>();

  constructor(
    readonly project: Project,
    private repoRoot: string,
    private projectDir: string,
    private config: Config,
    frameworks: Framework[] = [],
  ) {
    this.frameworkPackages = new Set(frameworks.flatMap((f) => f.packages));
    const all = <T>(own: T[], pick: (f: Framework) => T[] | undefined) => [...own, ...frameworks.flatMap((f) => pick(f) ?? [])];
    const entries = all(config.entryPoints, (f) => f.entryPoints);
    this.rules = {
      sinks: all(config.sinks, (f) => f.sinks),
      entries,
      decorators: all(config.decoratorEntries ?? [], (f) => f.decoratorEntries),
      responses: all(config.responses ?? [], (f) => f.responses),
      moduleDecorators: new Set(frameworks.flatMap((f) => f.moduleDecorators ?? [])),
      notModuleDecorators: new Set(frameworks.flatMap((f) => f.notModuleDecorators ?? [])),
      notModuleImplements: new Set(frameworks.flatMap((f) => f.notModuleImplements ?? [])),
      ignoreMethods: new Set(frameworks.flatMap((f) => f.ignoreMethods ?? [])),
      hooks: frameworks.flatMap((f) => (f.hooks ? [f.hooks] : [])),
      docs: all(config.docDecorators ?? [], (f) => f.docDecorators),
      fieldDocs: all(config.fieldDocDecorators ?? [], (f) => f.fieldDocDecorators),
      registries: config.entryRegistries ?? [],
      entryNames: new Set(entries.flatMap((r) => (methodsOf(r).includes('new') ? (r.class ?? '').split('|') : methodsOf(r)))),
      dispatchNames: new Set(frameworks.flatMap((f) => f.hooks?.dispatchNames ?? [])),
      transactions: frameworks.flatMap((f) => f.transactions ?? []),
      callbacks: all(config.callbacks ?? [], (f) => f.callbacks),
    };
  }

  run(): Snapshot {
    this.init();
    for (const cls of this.moduleIds.keys()) for (const method of this.publicMethods(cls)) this.extractOperation(cls, method);
    this.listEntryPoints();
    for (const id of this.entrySites.keys()) this.buildEntry(id);
    this.computeTransitiveEffects();
    return this.snapshot;
  }

  /** Module discovery only: which classes are modules. Cheap: no function bodies are analyzed. */
  init(): void {
    const modules = this.discoverModules(this.projectFiles().flatMap((f) => f.getClasses()));
    // Two modules with one class name get their folder in the display name: `Orders (legacy)`, `Orders (orders)`.
    const names = modules.map((c) => c.getName());
    this.sharedNames = new Set(names.filter((n, i) => n && names.indexOf(n) !== i) as string[]);
    for (const cls of modules) this.registerModule(cls);
  }

  /**
   * The service's own source files, without its tests: an e2e spec's `app.useGlobalPipes(…)` or `setGlobalPrefix`
   * sets up a test app, not the service's pipeline, and a spec's classes and mocks are not modules. Developer scripts
   * (a dot-folder such as `.dev/scripts/seed.ts`, a top-level `scripts/`) are not the service either.
   */
  private projectFiles() {
    return (this.projectFileList ??= this.project.getSourceFiles().filter((f) => {
      const rel = relative(this.projectDir, f.getFilePath()).replace(/\\/g, '/');
      return this.isProjectFile(f.getFilePath()) && !isTestFile(rel) && !isDevFile(rel);
    }));
  }
  private projectFileList?: ReturnType<Project['getSourceFiles']>;

  // ---------- lazy API ----------

  /** Public methods of all modules: the operations that exist, analyzed or not. */
  knownOperations(): string[] {
    return [...this.moduleIds.keys()].flatMap((cls) => this.publicMethods(cls).map((m) => this.opIdOf(cls, m.getName())));
  }

  /**
   * `<module id>.<method>`: `OrdersService.cancel`. Two classes with the same name are two modules
   * (`OrdersService`, `OrdersService@src/legacy/orders.service.ts`), so their operations stay apart too.
   */
  private opIdOf(cls: ClassDeclaration, method: string): string {
    return `${this.moduleIds.get(cls) ?? cls.getName()}.${method}`;
  }

  /** Class, file and parameter names of every module method: what the example recorder wraps. */
  operationTargets(): OperationTarget[] {
    return [...this.moduleIds.keys()].flatMap((cls) =>
      this.publicMethods(cls).map((m) => ({
        opId: this.opIdOf(cls, m.getName()),
        file: this.rel(cls.getSourceFile().getFilePath()),
        className: cls.getName()!,
        method: m.getName(),
        params: m.getParameters().map((p) => p.getName()),
      })),
    );
  }

  /**
   * Lists every entry point without analyzing any: registration calls (router.get, consumer.run, new Worker, …)
   * and decorated handlers (@Get, @EventPattern, @Cron, …). Names are checked before types, so this stays cheap.
   */
  listEntryPoints(): void {
    this.listed = true;
    for (const file of this.projectFiles()) {
      for (const node of file.getDescendants()) {
        if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
          if (this.rules.entryNames.has(calleeName(node))) this.entryIdOf(node);
        } else if (Node.isMethodDeclaration(node) && this.rules.decorators.length) {
          this.decoratorEntryOf(node);
        }
      }
    }
    for (const method of this.registryIndex().keys()) this.registryEntriesOf(method);
  }

  /** Analyzes an operation (its own scope); `deep` also analyzes everything it calls, recursively. */
  ensureOp(opId: string, deep = false): boolean {
    if (!this.snapshot.operations[opId]) {
      const found = this.findOp(opId);
      if (!found) return false;
      this.extractOperation(found.cls, found.method);
    }
    if (deep && !this.deep.has(opId)) {
      this.deep.add(opId);
      for (const callee of this.snapshot.operations[opId].calls) this.ensureOp(callee, true);
    }
    return true;
  }

  ensureEntry(id: string, deep = false): boolean {
    if (!this.snapshot.entryPoints[id]) return false;
    if (!this.snapshot.scopes[id]) this.buildEntry(id);
    if (deep && !this.deep.has(id)) {
      this.deep.add(id);
      for (const step of this.snapshot.scopes[id]?.steps ?? []) if (step.target) this.ensureOp(step.target, true);
    }
    return true;
  }

  /** Scopes (operations or entry points) with a step that calls `opId`. One level up, via the reference index. */
  callersOf(opId: string): string[] {
    const found = this.findOp(opId);
    if (!found) return [];
    const out = new Set<string>();
    for (const ref of found.method.findReferencesAsNodes()) {
      const call = callOf(ref);
      // References include calls through an interface or base class that resolve elsewhere (another implementation,
      // or nothing when several qualify): only calls that resolve to this operation are its callers.
      if (!call || !this.resolvesTo(call, opId)) continue;
      // Every scope the call is a step of, including other operations of the same class (`resolveHold` calls
      // `this.cancel`): `resolve` makes those steps too. A recursive call is not a caller.
      for (const id of this.scopesAt(call)) if (id !== opId) out.add(id);
    }
    // Handlers are reached through a bus (`commandBus.execute(new X())`), not by name.
    for (const name of this.rules.dispatchNames) {
      for (const call of this.callsNamed(name)) {
        if (this.resolvesTo(call, opId)) for (const id of this.scopesAt(call)) if (id !== opId) out.add(id);
      }
    }
    return [...out];
  }

  private resolvesTo(call: Invocation, opId: string): boolean {
    const r = this.resolve(call);
    return (r.kind === 'op' && r.opId === opId) || (r.kind === 'dispatch' && r.targets.some((t) => t.kind === 'op' && t.opId === opId));
  }

  /** Scopes whose analysis covers the given lines of a file: where a diff hunk lands in the graph. */
  scopesForLines(absPath: string, ranges: [number, number][]): string[] {
    const sf = this.project.getSourceFile(absPath);
    if (!sf) return [];
    const out = new Set<string>();
    const memo = new Map<Node, string[]>();
    const lines = sf.getFullText().split('\n');
    for (const [from, to] of ranges) {
      for (let line = from; line <= Math.min(to, lines.length); line++) {
        const text = lines[line - 1] ?? '';
        if (!text.trim()) continue;
        const pos = sf.compilerNode.getPositionOfLineAndCharacter(line - 1, text.length - text.trimStart().length);
        const node = sf.getDescendantAtPos(pos);
        if (!node) continue;
        const key = node.getFirstAncestor(isFnNode) ?? node.getFirstAncestor(isTypeDecl) ?? node;
        if (!memo.has(key)) memo.set(key, this.scopesOfChange(node));
        memo.get(key)!.forEach((id) => out.add(id));
      }
    }
    return [...out];
  }

  private scopesOfChange(node: Node): string[] {
    const typeDecl = node.getFirstAncestor(isTypeDecl);
    if (typeDecl && !node.getFirstAncestor(isFnNode)) {
      // A changed type changes every operation whose signature or body uses it.
      const out = new Set<string>();
      for (const ref of (typeDecl as unknown as { findReferencesAsNodes(): Node[] }).findReferencesAsNodes()) {
        if (ref.getFirstAncestor(isFnNode) || ref.getFirstAncestor(isTypeDecl) === undefined) this.scopesAt(ref).forEach((id) => out.add(id));
      }
      return [...out];
    }
    // A decorator line (`@Get(':id')`) belongs to the method it decorates.
    const decorated = node.getFirstAncestor((n) => Node.isDecorator(n))?.getParent();
    if (decorated && Node.isMethodDeclaration(decorated)) {
      const id = this.decoratorEntryOf(decorated);
      if (id) return [id];
    }
    // A changed DI binding (`{ provide: TOKEN, useClass: X }`): calls through the token now reach another class.
    const ctx = this.hookContext();
    for (const h of this.rules.hooks) {
      const consumers = h.consumersAt?.(node, ctx);
      if (consumers?.length) {
        return consumers.flatMap((c) => (this.moduleIds.has(c) ? this.publicMethods(c).map((m) => this.opIdOf(c, m.getName())) : c.getMethods().flatMap((m) => this.entriesOfMethod(m))));
      }
    }
    // A class decorator (`@Controller('orders')`, `@UseGuards(X)`) belongs to every handler in the class.
    if (decorated && Node.isClassDeclaration(decorated)) {
      const ids = decorated.getMethods().map((m) => this.decoratorEntryOf(m)).filter((x): x is string => !!x);
      if (ids.length) return [...new Set([...ids, ...this.scopesAt(node)])];
    }
    return this.scopesAt(node);
  }

  /**
   * Scopes whose steps would include something located at `node`: the entry handler or operation around it,
   * and, for helpers that get inlined, everything that calls the helper.
   */
  scopesAt(node: Node, seen = new Set<Node>(), thisClass?: ClassDeclaration): string[] {
    // Inside a guard, interceptor or middleware, or in the code that applies one: every entry point behind it.
    if (!this.listed) this.listEntryPoints();
    for (let cur: Node | undefined = node; cur; cur = cur.getParent()) {
      const behind = this.pipelineAt.get(cur);
      if (behind) return [...behind];
    }
    for (let cur = node.getParent(); cur; cur = cur.getParent()) {
      if (Node.isCallExpression(cur) || Node.isNewExpression(cur)) {
        const id = this.entryIdOf(cur);
        if (id) return [id];
      }
      if (Node.isMethodDeclaration(cur)) {
        const ids = this.entriesOfMethod(cur, thisClass);
        if (ids.length) return ids;
      }
      if (isFnNode(cur) && !isAnonymous(cur)) break;
    }
    let fn: Node | undefined = isFnNode(node) ? node : node.getFirstAncestor(isFnNode);
    while (fn && isAnonymous(fn) && !Node.isVariableDeclaration(fn.getParent())) fn = fn.getFirstAncestor(isFnNode);
    if (!fn || seen.has(fn)) return [];
    seen.add(fn);
    const out: string[] = [];
    let helperClass = thisClass;
    if (Node.isMethodDeclaration(fn)) {
      const entries = this.entriesOfMethod(fn, thisClass);
      if (entries.length) return entries;
      const cls = fn.getParent();
      // An override called as `this.x()` from a base class method: only the handlers running as this class reach it.
      if (Node.isClassDeclaration(cls) && !thisClass) helperClass = cls;
      // An operation is its own scope. Callers (in this class or another) have it as a step, not inlined, so
      // a change inside it does not change them.
      if (Node.isClassDeclaration(cls) && this.moduleIds.has(cls) && this.isOperation(fn)) return [this.opIdOf(cls, fn.getName())];
    }
    // A helper (private method, function, arrow in a variable): inlined wherever it is called.
    const named = Node.isVariableDeclaration(fn.getParent()) ? fn.getParent()! : fn;
    const refs = 'findReferencesAsNodes' in named ? (named as unknown as { findReferencesAsNodes(): Node[] }).findReferencesAsNodes() : [];
    for (const ref of refs) {
      const refClass = ref.getFirstAncestor((n) => Node.isClassDeclaration(n)) as ClassDeclaration | undefined;
      const viaBase = helperClass && refClass && refClass !== helperClass && isSubclassOf(helperClass, refClass);
      out.push(...this.scopesAt(ref, seen, viaBase ? helperClass : thisClass));
    }
    return [...new Set(out)];
  }

  private entryIdOf(call: Invocation): string | undefined {
    if (!this.entryIdCache.has(call)) this.entryIdCache.set(call, this.rules.entryNames.has(calleeName(call)) ? this.entryStub(call) : undefined);
    return this.entryIdCache.get(call);
  }

  private findOp(opId: string): { cls: ClassDeclaration; method: MethodDeclaration } | undefined {
    // Module ids may contain dots (`OrdersService@src/legacy/orders.service.ts`); method names don't.
    const dot = opId.lastIndexOf('.');
    const moduleId = opId.slice(0, dot);
    const name = opId.slice(dot + 1);
    const cls = [...this.moduleIds].find(([, id]) => id === moduleId)?.[0];
    const method = cls && this.publicMethods(cls).find((m) => m.getName() === name);
    return cls && method ? { cls, method } : undefined;
  }

  private publicMethods(cls: ClassDeclaration): MethodDeclaration[] {
    return cls.getMethods().filter((m) => this.isOperation(m));
  }

  private isOperation(m: MethodDeclaration): boolean {
    return m.getScope() === MemberScope.Public && !m.getName().startsWith('#') && !m.isStatic() && !this.rules.ignoreMethods.has(m.getName());
  }

  // ---------- in-house registrations (profile `entryRegistries`) ----------

  private registryMemo?: Map<MethodDeclaration, RegistryEntry[]>;

  /**
   * Handler methods the profile's registry rules make entry points, with their labels. Computed once. Several
   * handler classes may share one method they inherit from a base class (`handleBatch` on a shared base):
   * each class is an entry point of its own. A registered thing (a job, a consumer key) is ONE entry point, whatever
   * methods run it: a job whose providers have `onModuleInit` and `onApplicationBootstrap` runs both, in that order;
   * a listed method that another listed one calls (`onApplicationBootstrap() { await this.run(); }`) is a step of
   * it, not an entry point of its own.
   */
  private registryIndex(): Map<MethodDeclaration, RegistryEntry[]> {
    if (this.registryMemo) return this.registryMemo;
    const out = new Map<MethodDeclaration, RegistryEntry[]>();
    this.registryMemo = out;
    const seen = new Map<ClassDeclaration, Set<MethodDeclaration>>();
    for (const rule of this.rules.registries) {
      const methods = (rule.method ?? (rule.argv ? 'onApplicationBootstrap|onModuleInit|run' : 'handle')).split('|');
      // Through the base classes: a handler may inherit its method (methodOf walks the chain).
      const handlersOf = (cls: ClassDeclaration) =>
        methods.map((m) => methodOf(cls, m)).filter((m): m is MethodDeclaration => !!m && this.isProjectFile(m.getSourceFile().getFilePath()));
      const add = (classes: ClassDeclaration[], key: string, at: Node) => {
        const chain = classes
          .flatMap((cls) => this.startMethods(cls, handlersOf(cls), methods).map((method) => ({ method, cls })))
          .sort((a, b) => startRank(a.method.getName(), methods) - startRank(b.method.getName(), methods))
          .filter(({ method, cls }) => {
            const done = seen.get(cls) ?? new Set<MethodDeclaration>();
            seen.set(cls, done);
            return !done.has(method) && !!done.add(method);
          });
        if (!chain.length) return;
        const last = chain.at(-1)!;
        const label = this.fill(rule.label, [], { key, class: last.cls.getName() ?? '?', method: last.method.getName() });
        for (const { method, cls } of chain) {
          const list = out.get(method) ?? [];
          out.set(method, list);
          list.push({ rule, label, at, cls, chain });
        }
      };
      const listed = new Set<ClassDeclaration>();
      if (rule.map) {
        for (const item of this.registryItems(rule.map)) {
          const cls = this.classOf(item.value);
          if (!cls) continue;
          listed.add(cls);
          add([cls], item.key, item.at);
        }
      }
      if (rule.extends) {
        for (const file of this.projectFiles()) {
          for (const cls of file.getClasses()) if (!listed.has(cls) && !cls.isAbstract() && extendsNamed(cls, rule.extends)) add([cls], cls.getName() ?? '?', cls);
        }
      }
      if (rule.argv) {
        for (const { key, module, at } of this.argvModules(rule.argv)) {
          add(this.moduleProviders(module).filter((c) => handlersOf(c).length), key, at);
        }
      }
    }
    return out;
  }

  /** The listed methods of a handler class the framework calls itself: those no other listed method calls. */
  private startMethods(cls: ClassDeclaration, handlers: MethodDeclaration[], listed: string[]): MethodDeclaration[] {
    const reached = new Set<MethodDeclaration>();
    for (const h of handlers) for (const m of this.thisCallsFrom(h, cls)) if (m !== h) reached.add(m);
    const starts = handlers.filter((h) => !reached.has(h));
    return (starts.length ? starts : handlers.slice(0, 1)).sort((a, b) => startRank(a.getName(), listed) - startRank(b.getName(), listed));
  }

  /** Methods `fn` reaches through `this.x()` calls, as `cls` has them (own or inherited), transitively. */
  private thisCallsFrom(fn: MethodDeclaration, cls: ClassDeclaration): Set<MethodDeclaration> {
    const out = new Set<MethodDeclaration>();
    const queue = [fn];
    while (queue.length) {
      for (const call of queue.pop()!.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const e = call.getExpression();
        if (!Node.isPropertyAccessExpression(e) || e.getExpression().getKind() !== SyntaxKind.ThisKeyword) continue;
        const m = methodOf(cls, e.getName());
        if (m && !out.has(m)) {
          out.add(m);
          queue.push(m);
        }
      }
    }
    return out;
  }

  /** Entries of a `Map` or object literal held in a top-level variable called `name`: key, value and where. */
  private registryItems(name: string): { key: string; value: Node; at: Node }[] {
    const out: { key: string; value: Node; at: Node }[] = [];
    for (const file of this.projectFiles()) {
      for (const decl of file.getVariableDeclarations()) if (decl.getName() === name) out.push(...this.literalEntries(decl.getInitializer()));
    }
    return out;
  }

  /** `new Map([['a', A], …])` or `{ a: A, 'b-c': B }`. */
  private literalEntries(init: Node | undefined): { key: string; value: Node; at: Node }[] {
    const value = init && unwrap(init);
    if (!value) return [];
    if (Node.isNewExpression(value) && value.getExpression().getText() === 'Map') {
      const list = value.getArguments()[0];
      if (!list || !Node.isArrayLiteralExpression(list)) return [];
      return list.getElements().flatMap((el) => {
        if (!Node.isArrayLiteralExpression(el) || el.getElements().length < 2) return [];
        const [k, v] = el.getElements();
        const key = this.literal(k);
        return key.startsWith('<') || key === '?' ? [] : [{ key, value: v, at: el }];
      });
    }
    if (Node.isObjectLiteralExpression(value)) {
      return value.getProperties().flatMap((prop): { key: string; value: Node; at: Node }[] => {
        if (Node.isPropertyAssignment(prop)) return [{ key: prop.getName().replace(/^['"`]|['"`]$/g, ''), value: prop.getInitializer()!, at: prop }];
        if (Node.isShorthandPropertyAssignment(prop)) return [{ key: prop.getName(), value: prop.getNameNode(), at: prop }];
        return [];
      });
    }
    return [];
  }

  /**
   * Modules a bootstrap file starts per command-line argument: `NestFactory.createApplicationContext(JOBS[arg])` with
   * `JOBS = { 'some-poller': SomePollerModule }` (top-level or a local const), `NestFactory.create(modules[command].register())`
   * (dynamic modules), or `case 'some-poller':` / `if (arg === 'some-poller')` around
   * `NestFactory.createApplicationContext(SomePollerModule)`. The app started without an argument is not listed.
   */
  private argvModules(fileRel: string): { key: string; module: ClassDeclaration; at: Node }[] {
    const wanted = fileRel.replace(/\\/g, '/').replace(/^\.\//, '');
    const file = this.projectFiles().find((f) => relative(this.projectDir, f.getFilePath()).replace(/\\/g, '/') === wanted || f.getFilePath().endsWith(`/${wanted}`));
    if (!file) return [];
    const out: { key: string; module: ClassDeclaration; at: Node }[] = [];
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (!/(^|\.)(create|createApplicationContext|createMicroservice)$/.test(call.getExpression().getText()) || !/NestFactory/.test(call.getExpression().getText())) continue;
      let arg: Node | undefined = call.getArguments()[0] && unwrap(call.getArguments()[0]);
      for (let depth = 0; arg && depth < 5; depth++) {
        // A dynamic module (`JobModule.register()`, `modules[command].register()`): the module is the receiver.
        const callee = Node.isCallExpression(arg) ? arg.getExpression() : undefined;
        if (callee && Node.isPropertyAccessExpression(callee) && /^(register|registerAsync|forRoot|forRootAsync|forFeature)$/.test(callee.getName())) {
          arg = unwrap(callee.getExpression());
          continue;
        }
        if (Node.isIdentifier(arg)) {
          const decl = this.resolveDeclaration(arg);
          if (decl && Node.isClassDeclaration(decl)) {
            const key = commandAround(call, (n) => this.literal(n));
            if (key) out.push({ key, module: decl, at: call });
            break;
          }
          arg = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() && unwrap(decl.getInitializer()!) : undefined;
          continue;
        }
        // JOBS[arg], JOBS.get(arg): every entry of the registry
        const holder = Node.isElementAccessExpression(arg) ? arg.getExpression()
          : Node.isCallExpression(arg) && Node.isPropertyAccessExpression(arg.getExpression()) && (arg.getExpression() as never as { getName(): string }).getName() === 'get' ? (arg.getExpression() as never as { getExpression(): Node }).getExpression()
          : undefined;
        const decl = holder && this.resolveDeclaration(holder);
        if (decl && Node.isVariableDeclaration(decl)) {
          for (const item of this.literalEntries(decl.getInitializer())) {
            const cls = this.classOf(item.value);
            if (cls) out.push({ key: item.key, module: cls, at: item.at });
          }
        }
        break;
      }
    }
    return out;
  }

  /**
   * Classes a Nest module declares as providers (`X`, `{ provide, useClass: X }`): in `@Module({ providers })`, and in
   * what its static methods return (a dynamic module: `static register(): DynamicModule { return { providers } }`).
   */
  private moduleProviders(module: ClassDeclaration): ClassDeclaration[] {
    const objects: Node[] = [module.getDecorator('Module')?.getArguments()[0]].filter((n): n is Node => !!n);
    for (const m of module.getStaticMethods()) {
      for (const ret of m.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
        const e = ret.getExpression();
        if (e && Node.isObjectLiteralExpression(unwrap(e))) objects.push(unwrap(e));
      }
    }
    const elements = objects.flatMap((opts) => {
      const list = Node.isObjectLiteralExpression(opts) ? opts.getProperty('providers') : undefined;
      const items = list && Node.isPropertyAssignment(list) ? list.getInitializer() : undefined;
      return items && Node.isArrayLiteralExpression(items) ? items.getElements() : [];
    });
    return [...new Set(elements.flatMap((el) => {
      if (Node.isObjectLiteralExpression(el)) {
        const use = el.getProperty('useClass');
        const cls = use && Node.isPropertyAssignment(use) ? this.classOf(use.getInitializer()!) : undefined;
        return cls ? [cls] : [];
      }
      const cls = this.classOf(el);
      return cls ? [cls] : [];
    }))];
  }

  // ---------- what the analysis probably misses ----------

  private hintsMemo?: AnalysisIssue[];

  /**
   * Signs of entry points and side effects the analysis did not find, with the profile rule that would make them
   * visible: a message broker client but no consumer entry point, handler maps, scripts that start the app with an
   * argument, and packages that look like producers, outboxes or cloud clients that nothing describes.
   */
  private coverageHints(): AnalysisIssue[] {
    if (this.hintsMemo) return this.hintsMemo;
    const out: AnalysisIssue[] = [];
    this.hintsMemo = out;
    if (!this.listed) this.listEntryPoints();
    const ignore = new Set(this.config.coverage?.ignore ?? []);
    const pkg = readPackageJson(this.projectDir);
    // Only packages the service's own code uses for their values: a type-only import (`import type`, or a name used
    // only in types) runs nothing, and a developer script (a dot-folder, `scripts/`) is not the service.
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).filter((d) => !ignore.has(d) && this.valueImporters(d).length);
    const entries = Object.values(this.snapshot.entryPoints);
    const items: string[] = [];
    const rules: string[] = [];

    // 1. A broker client, directly or through a wrapper, and no consumer.
    const brokers = deps.flatMap((d) => (CONSUMER_PACKAGES.has(d) ? [{ dep: d, via: '' }] : wraps(this.projectDir, d).filter((m) => CONSUMER_PACKAGES.has(m)).map((m) => ({ dep: m, via: d }))));
    const consumers = entries.filter((e) => e.kind === 'consumer').length;
    const dynamic = [...this.dynamicEntries.values()].filter((d) => d.kind === 'consumer').map((d) => d.at);
    const dynamicText = dynamic.length ? `consumers are created dynamically in ${dynamic.slice(0, 3).join(', ')}${dynamic.length > 3 ? ', …' : ''}, with no topic this analysis can read (one per registered handler, say)` : '';
    if (brokers.length && !consumers) {
      const names = [...new Set(brokers.map((b) => (b.via ? `${b.via} (wraps ${b.dep})` : b.dep)))];
      items.push(`package.json depends on ${names.join(', ')}, but no consumer entry point was found${dynamicText ? ` (${dynamicText})` : ''}: consumers registered through a wrapper or a handler map are not seen, nor anything they reach`);
    } else if (dynamicText && !this.rules.registries.some((r) => r.kind === 'consumer')) {
      items.push(`${dynamicText.charAt(0).toUpperCase()}${dynamicText.slice(1)}: they are not entry points, nor anything they reach`);
    }
    // 2. Handler maps: a Map / object literal of classes that share a method, own or inherited.
    const covered = new Set(this.rules.registries.flatMap((r) => (r.map ? [r.map] : [])));
    const mapped = new Set<ClassDeclaration>();
    const handlerKeys = new Set<string>();
    for (const file of this.projectFiles()) {
      for (const decl of file.getVariableDeclarations()) {
        const name = decl.getName();
        const list = this.literalEntries(decl.getInitializer());
        const classes = list.map((i) => this.classOf(i.value)).filter((c): c is ClassDeclaration => !!c && this.isProjectFile(c.getSourceFile().getFilePath()));
        if (list.length < 2 || classes.length !== list.length || classes.some((c) => c.getDecorator('Module'))) continue;
        for (const c of classes) mapped.add(c);
        for (const i of list) handlerKeys.add(i.key);
        if (covered.has(name) || ignore.has(name)) continue;
        if (classes.some((c) => c.getMethods().some((m) => this.entriesOfMethod(m).length))) continue;
        const { method, base, inherited } = this.sharedHandler(classes);
        const bases = base ? [base.getName() ?? '?'] : [...new Set(classes.map((c) => c.getExtends()?.getExpression().getText()).filter(Boolean))];
        const kind = registryKind(`${name} ${bases.join(' ')}`);
        const label = kind === 'consumer' && brokers.some((b) => /kafka/.test(b.dep)) ? 'kafka consumer {key}' : `${kind} {key}`;
        const registers = base ? this.selfRegistration(base) : undefined;
        items.push(`${this.rel(file.getFilePath())}: \`${name}\` maps ${list.length} names to classes${bases.length === 1 ? ` extending ${bases[0]}` : ''}${registers ? ` (which registers every instance: ${registers})` : ''}${method ? ` with \`${method}()\`${inherited ? ` (${inherited} of them inherit it)` : ''}` : ''} (${list.slice(0, 4).map((i) => `'${i.key}'`).join(', ')}${list.length > 4 ? ', …' : ''}): none of them is an entry point${method ? '' : '; they share no public method: set "method" to the one the consumer calls'}`);
        rules.push(`{ "map": "${name}", "method": "${method ?? 'handle'}", "kind": "${kind}", "label": "${label}" }`);
      }
    }
    // 2b. Handlers that register themselves (`registry.add(this)` in a base class constructor), in no map.
    const ruledBases = new Set(this.rules.registries.flatMap((r) => (r.extends ? [r.extends] : [])));
    for (const file of this.projectFiles()) {
      for (const base of file.getClasses()) {
        const name = base.getName();
        if (!name || !base.isAbstract() || ruledBases.has(name) || ignore.has(name)) continue;
        const registers = this.selfRegistration(base, false);
        if (!registers) continue;
        const subs = this.projectFiles().flatMap((f) => f.getClasses()).filter((c) => !c.isAbstract() && isSubclassOf(c, base) && !mapped.has(c));
        if (subs.length < 2 || subs.some((c) => c.getMethods().some((m) => this.entriesOfMethod(m).length))) continue;
        const { method } = this.sharedHandler(subs);
        const kind = registryKind(name);
        items.push(`${this.rel(file.getFilePath())}: ${subs.length} classes extend ${name}, which registers every instance (${registers}), with \`${method ?? '?'}()\` (${subs.slice(0, 3).map((c) => c.getName()).join(', ')}${subs.length > 3 ? ', …' : ''}): none of them is an entry point`);
        rules.push(`{ "extends": "${name}", "method": "${method ?? 'handle'}", "kind": "${kind}", "label": "${kind} {key}" }`);
      }
    }
    // 3. Jobs: scripts that start the app with an argument, and the file that reads it. An argument that names
    //    handlers of a map (`nest start -- a-consumer,another`) selects consumers: not a job.
    const argvRuled = this.rules.registries.some((r) => r.argv);
    const scripts = argvScripts(pkg).filter((s) => !ignore.has(s.script) && !ignore.has(s.arg) && !entries.some((e) => e.label.includes(s.arg)) && !s.arg.split(',').every((a) => handlerKeys.has(a)));
    if (scripts.length && !argvRuled) {
      const reader = this.projectFiles().find((f) => /process\.argv/.test(f.getFullText()) && /NestFactory|bootstrap/.test(f.getFullText()));
      const where = reader ? relative(this.projectDir, reader.getFilePath()).replace(/\\/g, '/') : 'src/main.ts';
      items.push(`package.json scripts start the app with an argument (${scripts.slice(0, 4).map((s) => `${s.script}: \`${s.command}\``).join('; ')}${scripts.length > 4 ? '; …' : ''})${reader ? ` and ${where} reads process.argv` : ''}: jobs started this way are not entry points`);
      rules.push(`{ "argv": "${where}", "kind": "cron", "label": "job {key}" }`);
    }
    if (items.length) {
      out.push({
        kind: 'missing-entry-points',
        message: `Probably missing entry points: ${items.length === 1 ? 'one sign' : `${items.length} signs`} of handlers this analysis does not see (below). Flows that start there, and changes reached only from there, are not in this review.`,
        hint: rules.length
          ? 'Describe them in the service\'s profile with `entryRegistries` (below), then analyze again; they become consumer / cron entry points. Something that is not an entry point: add its name to `coverage.ignore`.'
          : 'Describe these handlers in the service\'s profile (`entryRegistries`, `entryPoints` or `decoratorEntries`; see docs/analyzers.md), then analyze again.',
        items,
        ...(rules.length ? { suggestion: `"entryRegistries": [\n  ${rules.join(',\n  ')}\n]` } : {}),
      });
    }

    // 4. Packages that look like producers, outboxes, queues or cloud clients, or that do network I/O (themselves or
    //    through what they are built on: a vendor's REST client on axios, an SFTP client on ssh2), which no adapter or
    //    rule describes. Their calls leave the process, and the review would not show them.
    const known = new Set([...allFrameworks.flatMap((f) => [...f.packages, ...(f.sinks ?? []).flatMap((s) => (s.module ?? '').split('|'))]), ...this.rules.sinks.flatMap((s) => (s.module ?? '').split('|'))].filter(Boolean));
    const sinkClasses = new Set(this.rules.sinks.flatMap((s) => (s.class ?? '').split('|')).filter(Boolean));
    const suspects = deps.filter((d) => !known.has(d) && (EFFECT_NAME.test(d) || wraps(this.projectDir, d).length || networkVia(this.projectDir, d).length));
    const fxItems: string[] = [];
    const sinks: string[] = [];
    const ignored: string[] = [];
    for (const dep of suspects) {
      const files = this.valueImporters(dep);
      const imported = new Set(files.flatMap((f) => f.getImportDeclarations().filter((i) => i.getModuleSpecifierValue() === dep || i.getModuleSpecifierValue().startsWith(`${dep}/`)).flatMap((i) => i.getNamedImports().map((n) => n.getName()))));
      if ([...imported].some((n) => sinkClasses.has(n))) continue;
      const calls = new Map<string, { n: number; owner: string; method: string; target: string; plain: boolean }>();
      for (const f of files) {
        for (const call of f.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const site = this.site(call);
          if (!site) continue;
          const ownerType = site.receiver?.getType().getSymbol()?.getName();
          const fromDep = site.pkg === dep || (!!ownerType && imported.has(ownerType));
          if (!fromDep || !site.name || site.name === 'new') continue;
          const owner = ownerType && (imported.has(ownerType) || site.pkg === dep) && site.receiver?.getType().isClass() ? ownerType : site.owner;
          const key = `${owner}.${site.name}`;
          const prev = calls.get(key);
          // A plain function (`sign(url, secret)`), not a method of something the package built: no client, no I/O.
          calls.set(key, { n: (prev?.n ?? 0) + 1, owner, method: site.name, target: prev?.target ?? suggestedTarget(site.decl, dep), plain: !site.owner });
        }
      }
      const via = wraps(this.projectDir, dep);
      // A messaging wrapper publishes in some calls only (`send`, not `producer()`). A network client that is no
      // messaging package does I/O in every call but opening, closing and configuring it (`getApplicant` too): its
      // target is the package, as no argument names a topic.
      const net = !via.length && !EFFECT_NAME.test(dep) ? networkVia(this.projectDir, dep) : [];
      // A package that can do network I/O, used only for its plain functions (a URL signer next to its HTTP
      // client): nothing the service calls on it leaves the process.
      if (net.length && calls.size && [...calls.values()].every((c) => c.plain)) continue;
      const effectful = [...calls.values()].filter((c) => !(net.length && c.plain) && (net.length ? isNetworkCall(c.method) : isEffectMethod(c.method))).map((c) => (net.length ? { ...c, target: `const:${dep}` } : c));
      const built = via.length ? ` (wraps ${via.join(', ')})` : net.length && net[0] !== dep ? ` (network I/O through ${net.join(', ')})` : net.length ? ' (network I/O)' : '';
      fxItems.push(`${dep}${built}: ${calls.size ? [...calls.entries()].map(([k, c]) => `${k}${c.n > 1 ? ` ×${c.n}` : ''}`).join(', ') : `${[...imported].join(', ')} imported`} in ${files.map((f) => this.rel(f.getFilePath())).slice(0, 2).join(', ')}${files.length > 2 ? ', …' : ''}`);
      for (const c of effectful) {
        sinks.push(`{ "class": "${c.owner}", "module": "${dep}", "method": "${c.method}", "kind": "${sinkKind(dep, c.owner)}", "target": "${c.target}" }`);
      }
      // Flagged, but no call of it looks like I/O: the rule to act on is to say it has none.
      if (!effectful.length) ignored.push(dep);
    }
    if (fxItems.length) {
      out.push({
        kind: 'unknown-side-effects',
        message: `${fxItems.length} package${fxItems.length > 1 ? 's look' : ' looks'} like ${fxItems.length > 1 ? 'producers, outboxes or network clients' : 'a producer, an outbox or a network client'}, but no adapter or profile rule describes ${fxItems.length > 1 ? 'them' : 'it'}: calls into ${fxItems.length > 1 ? 'them' : 'it'} are not side effects in this review (no Kafka topic, outbox event or external call is shown for them).`,
        hint: 'Describe the calls that publish, write or call out as `sinks` in the service\'s profile (suggested below: check the kind and which argument names the topic or event; factories such as `producer()` and `connect()` are left out), then analyze again. A package with no call that looks like I/O is suggested for `coverage.ignore`: check that it has none.',
        items: fxItems,
        suggestion: [
          ...(sinks.length ? [`"sinks": [\n  ${sinks.join(',\n  ')}\n]`] : []),
          ...(ignored.length ? [`"coverage": { "ignore": [${[...(this.config.coverage?.ignore ?? []), ...ignored].map((d) => `"${d}"`).join(', ')}] }`] : []),
        ].join(',\n'),
      });
    }
    return out;
  }

  /** Project files that import `dep` (or a subpath) for its values: `import type` and names used only as types don't count. */
  private valueImporters(dep: string): SourceFile[] {
    const memo = (this.importersMemo ??= new Map<string, SourceFile[]>());
    if (!memo.has(dep)) {
      memo.set(dep, this.projectFiles().filter((f) => f.getImportDeclarations().some((i) => {
        const s = i.getModuleSpecifierValue();
        if ((s !== dep && !s.startsWith(`${dep}/`)) || i.isTypeOnly()) return false;
        if (i.getNamespaceImport() || i.getDefaultImport()) return true;
        const named = i.getNamedImports();
        if (!named.length) return true; // `import 'x'`: run for its side effects
        return named.some((n) => !n.isTypeOnly() && usedAsValue(f, (n.getAliasNode() ?? n.getNameNode()).getText()));
      })));
    }
    return memo.get(dep)!;
  }
  private importersMemo?: Map<string, SourceFile[]>;

  /**
   * The method handler classes share, own or inherited: an abstract method of their common base class first (the
   * base says what every handler implements), else a usual handler name. Handler names come in families
   * (`handle*`, `process*`, `consume*`, `on*` other than lifecycle hooks, `execute`, `run`); within one, a method
   * that takes a batch (an array parameter) wins.
   */
  private sharedHandler(classes: ClassDeclaration[]): { method?: string; base?: ClassDeclaration; inherited: number } {
    const ancestors = (c: ClassDeclaration) => {
      const out: ClassDeclaration[] = [];
      for (let k = c.getBaseClass(), d = 0; k && d < 8; k = k.getBaseClass(), d++) out.push(k);
      return out;
    };
    const base = ancestors(classes[0]).find((b) => classes.every((c) => ancestors(c).includes(b)));
    const names = (c: ClassDeclaration) => new Set([c, ...ancestors(c)].flatMap((k) => k.getMethods().filter((m) => this.isOperation(m)).map((m) => m.getName())));
    const common = classes.map(names).reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
    const declOf = (n: string) => [classes[0], ...ancestors(classes[0])].map((k) => k.getMethod(n)).find(Boolean);
    const batch = (n: string) => !!declOf(n)?.getParameters().some((p) => p.getType().isArray());
    const family = (n: string) => (HANDLER_FAMILIES.findIndex((re) => re.test(n)) + 1 || 99) * 2 - (batch(n) ? 1 : 0);
    const pick = (list: string[]) => [...list].sort((a, b) => family(a) - family(b))[0];
    const abstract = base ? [base, ...ancestors(base)].flatMap((k) => k.getMethods().filter((m) => m.isAbstract() && common.has(m.getName())).map((m) => m.getName())) : [];
    const method = pick(abstract) ?? pick([...common].filter((n) => n !== 'constructor' && !LIFECYCLE_HOOK.test(n)));
    const inherited = method ? classes.filter((c) => !c.getMethod(method)).length : 0;
    return { method, base, inherited };
  }

  /** `registry.add(this)` in the constructor of this class (or, with `up`, a base class): how it says so. */
  private selfRegistration(cls: ClassDeclaration, up = true): string | undefined {
    for (let k: ClassDeclaration | undefined = cls, d = 0; k && d < 8; k = up ? k.getBaseClass() : undefined, d++) {
      for (const ctor of k.getConstructors()) {
        const call = ctor.getDescendantsOfKind(SyntaxKind.CallExpression).find((c) => c.getArguments().some((a) => a.getKind() === SyntaxKind.ThisKeyword) && c.getExpression().getKind() !== SyntaxKind.SuperKeyword);
        if (call) return `\`${short(call.getText(), 50)}\` in ${k.getName()}'s constructor`;
      }
    }
    return undefined;
  }

  // ---------- completeness ----------

  /**
   * What may have made this analysis miss things. Imports of packages that aren't installed (or path aliases
   * that don't resolve) turn every call into them into "unknown": no side effects, no entry points, and no error.
   * A single call that resolves to nothing (an untyped dependency) is a gap of the operation it is in, shown there.
   */
  issues(): AnalysisIssue[] {
    const out: AnalysisIssue[] = [...this.coverageHints()];
    const missing = this.missingImports ??= this.findMissingImports();
    if (missing.size) {
      const fw = [...missing.keys()].filter((p) => this.frameworkPackages.has(p));
      const packages = [...fw, ...[...missing.keys()].filter((p) => !fw.includes(p)).sort()];
      const n = missing.size;
      out.push({
        kind: 'unresolved-imports',
        message: `${n} imported package${n > 1 ? 's are' : ' is'} not installed${fw.length ? ` (${fw.length} of them used by the framework adapters)` : ''}: ${packages.slice(0, 8).join(', ')}${packages.length > 8 ? ', …' : ''}. Calls into ${n > 1 ? 'them' : 'it'} resolve to nothing, so their side effects and entry points are missing from this review.`,
        hint: `Install the service's dependencies (npm install in ${this.rel(this.projectDir) || '.'}), or fix the tsconfig paths if these are path aliases, then analyze again.`,
        items: packages.map((p) => `${p} (imported in ${[...missing.get(p)!].slice(0, 2).join(', ')}${missing.get(p)!.size > 2 ? ', …' : ''})`),
      });
    }
    // I5: every HTTP route the framework declares is an entry point.
    const routes = this.rules.decorators.filter((r) => r.kind === 'api' && r.decorator);
    for (const file of this.projectFiles()) {
      for (const cls of file.getClasses()) {
        for (const m of cls.getMethods()) {
          if (!m.getDecorators().length || !routes.some((r) => this.findDecorator(m, r.decorator!, r.from))) continue;
          if (this.entriesOfMethod(m).length) continue;
          const id = `${cls.getName()}.${m.getName()}`;
          out.push({ kind: 'invariant', scope: id, message: `I5: ${id} (${this.rel(file.getFilePath())}:${m.getStartLineNumber()}) is an HTTP route, but not an entry point of this review` });
        }
      }
    }
    return out;
  }

  private missingImports?: Map<string, Set<string>>;

  /** Packages (by name) imported somewhere in the project but not installed, with the files importing them. */
  private findMissingImports(): Map<string, Set<string>> {
    const missing = new Map<string, Set<string>>();
    for (const file of this.projectFiles()) {
      for (const decl of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
        const spec = decl.getModuleSpecifierValue();
        if (!spec || spec.startsWith('.') || spec.startsWith('/') || decl.getModuleSpecifierSourceFile()) continue;
        const builtin = spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0]);
        const pkg = builtin ? '@types/node' : packageRoot(spec);
        // Installed but untyped (plain JavaScript): calls into it are unresolved, which the call count below catches.
        if (installed(this.projectDir, pkg)) continue;
        if (!missing.has(pkg)) missing.set(pkg, new Set());
        missing.get(pkg)!.add(this.rel(file.getFilePath()));
      }
    }
    return missing;
  }

  /** Changed lines of executable code that no scope covers: code the graph would silently leave out of the review. */
  unmappedChanges(absPath: string, ranges: [number, number][]): string[] {
    // Tests and dev tooling (seed data, scripts, migrations) run outside the service's flows.
    if (/\.(spec|test|e2e-spec)\.[cm]?[jt]sx?$|\.d\.ts$/.test(absPath) || !this.isProjectFile(absPath)) return [];
    if (/\/(__tests__|__mocks__|tests?|e2e|dev|scripts?|seeds?|seeders?|migrations?|mocks?|fixtures?|bench(marks?)?)\//.test(`/${this.rel(absPath)}`)) return [];
    const sf = this.project.getSourceFile(absPath);
    if (!sf) return [];
    const out = new Map<Node, string>();
    const memo = new Map<Node, boolean>();
    const lines = sf.getFullText().split('\n');
    for (const [from, to] of ranges) {
      for (let line = from; line <= Math.min(to, lines.length); line++) {
        const text = lines[line - 1] ?? '';
        if (!text.trim() || /^\s*(\/\/|\/?\*)/.test(text)) continue;
        const node = sf.getDescendantAtPos(sf.compilerNode.getPositionOfLineAndCharacter(line - 1, text.length - text.trimStart().length));
        const fn = node && (isFnNode(node) ? node : node.getFirstAncestor(isFnNode));
        if (!node || !fn || this.isWiring(node)) continue;
        // The named function this code belongs to (a callback's enclosing method).
        let named: Node = fn;
        while (isAnonymous(named) && !Node.isVariableDeclaration(named.getParent()) && named.getFirstAncestor(isFnNode)) named = named.getFirstAncestor(isFnNode)!;
        if (out.has(named)) continue;
        if (!memo.has(named)) memo.set(named, this.scopesOfChange(node).length > 0);
        if (memo.get(named)) continue;
        out.set(named, `${fnName(named)} (${this.rel(absPath)}:${named.getStartLineNumber()})`);
      }
    }
    return [...out.values()];
  }

  /**
   * A line of composition-root wiring: `const x = new BirthInfoModule(new Store(db), outbox)` or a factory's
   * `() => new EmailNotifier()`. Calls are resolved by type, so constructing modules changes no flow.
   */
  private isWiring(node: Node): boolean {
    const stmt = node.getFirstAncestor((n) => Node.isStatement(n) || isFnNode(n));
    let values: (Node | undefined)[] = [];
    if (stmt && Node.isVariableStatement(stmt)) values = stmt.getDeclarations().map((d) => d.getInitializer());
    else if (stmt && Node.isExpressionStatement(stmt)) {
      const e = stmt.getExpression();
      values = [Node.isBinaryExpression(e) && e.getOperatorToken().getKind() === SyntaxKind.EqualsToken ? e.getRight() : e];
    } else if (stmt && Node.isReturnStatement(stmt)) values = [stmt.getExpression()];
    else if (stmt && Node.isArrowFunction(stmt) && !Node.isBlock(stmt.getBody())) values = [stmt.getBody()];
    return values.length > 0 && values.every((v) => {
      const value = v && unwrap(v);
      if (!value || !Node.isNewExpression(value)) return false;
      const cls = this.resolveDeclaration(value.getExpression());
      return !!cls && Node.isClassDeclaration(cls) && this.isProjectFile(cls.getSourceFile().getFilePath());
    });
  }

  // ---------- modules & operations ----------

  /**
   * Finds modules from code structure alone, so the analyzed repo needs no changes: a class is a module when it has
   * public methods and takes part in dependency injection (it is injected into another class, or injects collaborators
   * itself), or carries a framework's provider decorator (`@Injectable`). Platform classes named by sink/entry rules,
   * classes that host entry points (controllers, processors) and framework wiring (`@Module`, `@Entity`, guards) are
   * not modules. Config include/exclude and an optional opt-in JSDoc tag adjust the result.
   */
  private discoverModules(classes: ClassDeclaration[]): ClassDeclaration[] {
    const key = (c: ClassDeclaration) => `${c.getSourceFile().getFilePath()}#${c.getName()}`;
    const platform = new Set([...this.rules.sinks, ...this.rules.entries].flatMap((r) => (r.class ?? '').split('|')).filter(Boolean));
    const injected = new Set<string>();
    const injects = new Set<string>();
    for (const cls of classes) {
      for (const param of cls.getConstructors()[0]?.getParameters() ?? []) {
        const decl = param.getType().getSymbol()?.getDeclarations()[0];
        if (!decl || !(Node.isClassDeclaration(decl) || Node.isInterfaceDeclaration(decl))) continue;
        injects.add(key(cls));
        if (Node.isClassDeclaration(decl)) injected.add(key(decl));
      }
    }
    const { include, exclude } = this.config.modules;
    return classes.filter((cls) => {
      const name = cls.getName();
      if (!name || platform.has(name) || exclude.includes(name)) return false;
      const tagged = cls.getJsDocs().some((d) => d.getTags().some((t) => t.getTagName() === this.config.moduleTag));
      if (include.includes(name) || tagged) return true;
      // An abstract class is a contract: the classes that implement it are the modules.
      if (cls.isAbstract()) return false;
      const decorators = cls.getDecorators().map((d) => d.getName());
      if (decorators.some((d) => this.rules.notModuleDecorators.has(d))) return false;
      if (cls.getImplements().some((i) => this.rules.notModuleImplements.has(i.getExpression().getText()))) return false;
      if (this.rules.decorators.length && cls.getMethods().some((m) => this.decoratorEntryOf(m))) return false;
      // A handler a profile registry lists (its method may be inherited) is an entry point, not a module.
      if (this.rules.registries.length && [...this.registryIndex().values()].some((list) => list.some((r) => r.cls === cls))) return false;
      const hasPublicMethods = cls.getMethods().some((m) => this.isOperation(m));
      return hasPublicMethods && (injected.has(key(cls)) || injects.has(key(cls)) || decorators.some((d) => this.rules.moduleDecorators.has(d)));
    });
  }

  private registerModule(cls: ClassDeclaration): void {
    const docs = cls.getJsDocs();
    const tags = docs.flatMap((d) => d.getTags());
    const className = cls.getName() ?? 'Anonymous';
    const override = this.config.modules.overrides[className] ?? {};
    const id = this.snapshot.modules[className] ? `${className}@${this.rel(cls.getSourceFile().getFilePath())}` : className;
    const description = docs.map((d) => d.getDescription().trim()).join(' ').trim();
    const named = /^([A-Z][\w]*):\s*(.*)$/s.exec(description);
    const parse = (text: string): Effect => {
      const [kind, target] = text.trim().split(/\s+/);
      return { kind: kind as Effect['kind'], target };
    };
    const tagEffects = tags.filter((t) => t.getTagName() === 'effect').map((t) => parse(t.getCommentText() ?? ''));
    const declaredEffects = override.effects ? override.effects.map(parse) : tagEffects;
    const file = this.rel(cls.getSourceFile().getFilePath());
    this.moduleIds.set(cls, id);
    this.snapshot.modules[id] = {
      id,
      name: override.name ?? `${named ? named[1] : className.replace(/(Module|Service)$/, '') || className}${this.sharedNames.has(className) ? ` (${basename(dirname(cls.getSourceFile().getFilePath()))})` : ''}`,
      className,
      file,
      line: cls.getStartLineNumber(),
      summary: (override.summary ?? (named ? named[2] : description)).replace(/\s+/g, ' '),
      ...(override.summary ? { summarySource: 'profile' as const } : description ? { summarySource: 'code' as const } : {}),
      owner: override.owner ?? this.ownerOf(file) ?? tags.find((t) => t.getTagName() === 'owner')?.getCommentText()?.trim(),
      declaredEffects,
      ...(override.effects ? { contractSource: 'config' as const } : tagEffects.length ? { contractSource: 'tags' as const } : {}),
      operations: [],
      change: 'unchanged',
    };
    this.snapshot.fingerprints[`module:${id}`] = normalise(cls.getText());
  }

  private extractOperation(cls: ClassDeclaration, method: MethodDeclaration): void {
    const moduleId = this.moduleIds.get(cls)!;
    const id = this.opIdOf(cls, method.getName());
    if (this.snapshot.operations[id]) return;
    this.currentClass = cls;
    const scope = this.buildScope(id, method);
    this.currentClass = undefined;
    const steps = scope.result.steps;
    if (!this.snapshot.modules[moduleId].operations.includes(id)) this.snapshot.modules[moduleId].operations.push(id);
    const doc = jsDocOf(method);
    // No doc comment on the method: the class's own says what its operations are for (`summarySource: class`).
    const classDoc = doc ? '' : jsDocOf(cls).replace(/^[A-Z][\w]*:\s*/, '');
    this.snapshot.operations[id] = {
      id,
      moduleId,
      name: method.getName(),
      file: this.rel(method.getSourceFile().getFilePath()),
      line: method.getStartLineNumber(),
      endLine: method.getEndLineNumber(),
      ...(doc ? { summary: doc, summarySource: 'code' as const } : classDoc ? { summary: classDoc, summarySource: 'class' as const } : {}),
      params: this.params(method),
      returns: this.shape(unwrapPromise(method.getReturnType()), method),
      directEffects: dedupeEffects(steps.filter((s) => s.effect).map((s) => s.effect!)),
      effects: [],
      calls: [...new Set(steps.filter((s) => s.target).map((s) => s.target!))],
      change: 'unchanged',
      containsChanges: false,
      source: dedent(method.getText()),
      ...(this.gapsOf.get(id)?.length ? { gaps: this.gapsOf.get(id) } : {}),
    };
    this.recordParts(id, { name: method.getName(), role: 'operation', file: this.rel(method.getSourceFile().getFilePath()), line: method.getStartLineNumber(), text: method.getText() }, scope.result.parts);
  }

  // ---------- entry points ----------

  /** Registers an entry point from its registration call, without analyzing the handler. Returns its id. */
  private entryStub(call: Invocation): string | undefined {
    const site = this.site(call);
    if (!site) return undefined;
    const rule = this.rules.entries.find((r) => matches(r, site));
    if (!rule) return undefined;
    const args = call.getArguments();
    const handlerNode = this.handlerNode(rule, args);
    const handler = this.toFn(handlerNode);
    if (!handler) return undefined;
    const ctx = this.hookContext();
    const vars: Record<string, string> = {
      verb: site.name.toUpperCase(),
      at: `${basename(call.getSourceFile().getFilePath())}:${call.getStartLineNumber()}`,
      ...(handlerNode && !isFnNode(handlerNode) ? { handlerName: short(handlerNode.getText(), 40) } : {}),
    };
    for (const h of this.rules.hooks) Object.assign(vars, h.entryVars?.(site, ctx));
    const label = this.fill(rule.label, args, vars);
    // An adapter marks a name it could not read with `?` (`topic ?`): such an entry point would name nothing.
    if (/(^|[\s(,])\?($|[\s),])/.test(label)) {
      const at = `${this.rel(call.getSourceFile().getFilePath())}:${call.getStartLineNumber()}`;
      this.dynamicEntries.set(at, { kind: rule.kind, at });
      return undefined;
    }
    return this.addEntry(`${rule.kind}:${label}`, rule.kind, label, rule.readOnly, { at: call, handler });
  }

  /**
   * Entry points a profile registry makes of this method: one per handler class (several may inherit the method).
   * With `thisClass`, only the handlers that run as that class or a subclass of it (a change in its override).
   */
  private registryEntriesOf(method: MethodDeclaration, thisClass?: ClassDeclaration): string[] {
    return (this.registryIndex().get(method) ?? [])
      .filter((r) => !thisClass || r.cls === thisClass || isSubclassOf(r.cls, thisClass))
      .map((r) => {
        const last = r.chain.at(-1) ?? { method, cls: r.cls };
        return this.addEntry(`${r.rule.kind}:${r.label}`, r.rule.kind, r.label, false, { at: r.at, handler: last.method, thisClass: last.cls, before: r.chain.slice(0, -1) });
      });
  }

  /** Every entry point a method is: registry entries, else its decorators. */
  private entriesOfMethod(method: MethodDeclaration, thisClass?: ClassDeclaration): string[] {
    const reg = this.registryEntriesOf(method, thisClass);
    if (reg.length || this.registryIndex().has(method)) return reg;
    const id = this.decoratorEntryOf(method);
    return id ? [id] : [];
  }

  /** A method that is an entry point by its decorators (`@Get(':id')` in a `@Controller('orders')`). Returns its id. */
  private decoratorEntryOf(method: MethodDeclaration): string | undefined {
    if (this.entryIdCache.has(method)) return this.entryIdCache.get(method);
    let id: string | undefined;
    const cls = method.getParent();
    if (Node.isClassDeclaration(cls) && method.getDecorators().length + cls.getDecorators().length > 0) {
      for (const rule of this.rules.decorators) {
        const classDec = rule.classDecorator ? this.findDecorator(cls, rule.classDecorator, rule.from) : undefined;
        if (rule.classDecorator && !classDec) continue;
        const dec = rule.decorator ? this.findDecorator(method, rule.decorator, rule.from) : undefined;
        if (rule.decorator ? !dec : method.getName() !== rule.method) continue;
        const args = dec?.getArguments() ?? [];
        const classArgs = classDec?.getArguments() ?? [];
        const name = method.getName();
        const vars: Record<string, string> = {
          verb: (dec?.getName() ?? name).toUpperCase(),
          class: cls.getName() ?? 'Anonymous',
          method: name,
          Method: name.charAt(0).toUpperCase() + name.slice(1),
          path: joinPath(this.globals().globalPrefix, this.pathOf(classArgs[0]), this.pathOf(args[0])),
        };
        classArgs.forEach((a, i) => {
          vars[`class.${i}`] = this.literal(a);
          if (Node.isObjectLiteralExpression(a)) for (const p of a.getProperties()) if (Node.isPropertyAssignment(p)) vars[`class.${i}.${p.getName()}`] = this.literal(p.getInitializer());
        });
        const ctx = this.hookContext();
        for (const h of this.rules.hooks) Object.assign(vars, h.decoratorVars?.(method, cls, dec, ctx));
        const label = this.fill(rule.label, args, vars);
        const known = this.entrySites.has(`${rule.kind}:${label}`);
        id = this.addEntry(`${rule.kind}:${label}`, rule.kind, label, rule.readOnly, { at: method, handler: method });
        if (!known) this.setPipeline(id, method, cls, vars);
        break;
      }
    }
    this.entryIdCache.set(method, id);
    return id;
  }

  /**
   * What runs before the handler (adapters' `pipeline` hooks: Nest guards, interceptors, middleware, …). Recorded on
   * the entry point and indexed, so a change to a guard or to where it is applied maps to the entry points behind it.
   */
  private setPipeline(id: string, method: MethodDeclaration, cls: ClassDeclaration, vars: Record<string, string>): void {
    const ctx = this.hookContext();
    const specs = this.rules.hooks.flatMap((h) => h.pipeline?.(method, cls, vars, ctx) ?? []);
    if (!specs.length) {
      // An adapter that knows the pipeline found nothing in front of this handler: say so (empty), so a new endpoint
      // reads "guarded by nothing" rather than "not known".
      if (this.rules.hooks.some((h) => h.pipeline)) this.snapshot.entryPoints[id].pipeline = [];
      return;
    }
    this.pipelines.set(id, specs);
    this.snapshot.entryPoints[id].pipeline = specs.map((s): PipelineItem => ({
      kind: s.kind, name: s.name, scope: s.scope, file: this.rel(s.at.getSourceFile().getFilePath()), line: s.at.getStartLineNumber(),
    }));
    for (const s of specs) {
      for (const node of [s.at, s.fn]) {
        if (!node) continue;
        if (!this.pipelineAt.has(node)) this.pipelineAt.set(node, new Set());
        this.pipelineAt.get(node)!.add(id);
      }
    }
  }

  private addEntry(id: string, kind: EntryPoint['kind'], label: string, readOnly: boolean | undefined, site: EntrySite): string {
    if (this.entrySites.has(id)) return id;
    this.entrySites.set(id, site);
    this.snapshot.entryPoints[id] = {
      id,
      kind,
      label,
      ...this.handlerSummary(site.handler),
      readOnly: readOnly ?? (kind === 'grpc' && /\/(Get|List|Check|Find)/.test(label)),
      file: this.rel(site.at.getSourceFile().getFilePath()),
      line: site.at.getStartLineNumber(),
      effects: [],
      change: 'unchanged',
      containsChanges: false,
    };
    return id;
  }

  private buildEntry(id: string): void {
    const { at, handler, thisClass, before = [] } = this.entrySites.get(id)!;
    const entry = this.snapshot.entryPoints[id];
    // Guards, interceptors and middleware run on every request: their steps (and side effects) are the entry's too.
    const specs = this.pipelines.get(id) ?? [];
    const prelude: Prelude[] = specs.flatMap((s, i) => (s.fn && isFn(s.fn) ? [{ fn: s.fn, name: fnName(s.fn), item: i, label: `${s.kind} ${s.name}` }] : []));
    // Methods the framework calls before the handler (a job's earlier start hooks): steps of the same entry point.
    prelude.push(...before.map((b) => ({ fn: b.method, name: `${b.cls.getName()}.${b.method.getName()}`, item: -1, cls: b.cls })));
    const outer = this.currentClass;
    this.currentClass = thisClass;
    const scope = this.buildScope(id, handler, prelude);
    this.currentClass = outer;
    for (const p of scope.prelude) if (entry.pipeline?.[p.item]) entry.pipeline[p.item].functions = p.functions;
    if (this.gapsOf.get(id)?.length) entry.gaps = this.gapsOf.get(id);
    const label = entry.label;
    // Where the pipeline items are applied is part of the entry point too: removing `@UseGuards(X)` changes it.
    const pipeline = (entry.pipeline ?? []).map(pipelineKey).join('\n');
    this.recordParts(id, { name: label, role: 'handler', file: this.rel(at.getSourceFile().getFilePath()), line: at.getStartLineNumber(), text: at.getText() }, scope.result.parts, pipeline);
  }

  private recordParts(id: string, own: Part, inlined: Part[], extra = ''): void {
    const seen = new Set<string>();
    const parts = [own, ...inlined].filter((p) => !seen.has(p.name) && !!seen.add(p.name));
    this.snapshot.parts[id] = parts.map((p) => ({ ...p, text: dedent(p.text) }));
    this.snapshot.fingerprints[id] = normalise([own.text, ...inlined.map((p) => p.text), extra].join('\n'));
  }

  /** What a handler says it does: its doc comment, else its API documentation (`@ApiOperation({ description })`). */
  private handlerSummary(handler: Fn): Pick<EntryPoint, 'summary' | 'summarySource' | 'summaryFrom'> {
    const doc = Node.isMethodDeclaration(handler) || Node.isFunctionDeclaration(handler) ? jsDocOf(handler) : '';
    if (doc) return { summary: doc, summarySource: 'code' };
    const api = Node.isMethodDeclaration(handler) ? this.docDecorator(handler, this.rules.docs) : undefined;
    return api ? { summary: api.text, summarySource: 'api', summaryFrom: api.decorator } : {};
  }

  /** The first description a doc decorator gives: `@ApiOperation({ description })`, `@ApiProperty('…')`. */
  private docDecorator(node: { getDecorators(): Decorator[] }, rules: DocDecoratorRule[]): { text: string; decorator: string } | undefined {
    for (const rule of rules) {
      const dec = this.findDecorator(node, rule.decorator, rule.from);
      const arg = dec?.getArguments()[0];
      if (!dec || !arg) continue;
      if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) return { text: squashText(arg.getLiteralValue()), decorator: `@${dec.getName()}` };
      if (!Node.isObjectLiteralExpression(arg)) continue;
      for (const name of rule.props) {
        const prop = arg.getProperty(name);
        const value = prop && Node.isPropertyAssignment(prop) ? this.literal(prop.getInitializer()) : undefined;
        if (value && value !== '?' && !value.startsWith('<')) return { text: squashText(value), decorator: `@${dec.getName()}` };
      }
    }
    return undefined;
  }

  /** A field's description: its doc comment, else a field doc decorator (`@ApiProperty({ description })`). */
  private fieldDoc(decl: Node | undefined): string | undefined {
    if (!decl || !(Node.isPropertyDeclaration(decl) || Node.isPropertySignature(decl))) return undefined;
    const doc = jsDocOf(decl);
    if (doc) return doc;
    return Node.isPropertyDeclaration(decl) ? this.docDecorator(decl, this.rules.fieldDocs)?.text : undefined;
  }

  /** Where the rule says the handler is: `arg:N`, `arg:N.prop` or `last`, with `|` alternatives. */
  private handlerNode(rule: EntryRule, args: Node[]): Node | undefined {
    for (const spec of (rule.handler ?? `arg:${rule.handlerArg ?? 1}`).split('|')) {
      const node = spec === 'last' ? args.at(-1) : argNode(args, spec.replace(/^arg:/, ''));
      if (node && this.toFn(node)) return node;
    }
    return undefined;
  }

  private toFn(node: Node | undefined): Fn | undefined {
    if (!node) return undefined;
    if (Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isMethodDeclaration(node)) return node;
    if (Node.isPropertyAssignment(node)) return this.toFn(node.getInitializer());
    if (Node.isCallExpression(node)) {
      // `handler.bind(this)`, or a wrapper such as `asyncHandler(async (req, res) => …)`.
      const callee = node.getExpression();
      if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'bind') return this.toFn(callee.getExpression());
      for (const arg of [...node.getArguments()].reverse()) {
        const fn = Node.isArrowFunction(arg) || Node.isFunctionExpression(arg) ? arg : undefined;
        if (fn) return fn;
      }
      return undefined;
    }
    const resolved = this.resolveDeclaration(node);
    return resolved && isFn(resolved) ? resolved : undefined;
  }

  // ---------- scopes ----------

  private buildScope(id: string, fn: Fn, prelude: Prelude[] = []): { scope: Scope; result: FnResult; prelude: { item: number; functions: string[] }[] } {
    this.stepCounter = 0;
    const outerTrace = this.trace;
    const trace = (this.trace = new Trace());
    // Pipeline functions first (they run before the handler), as if inlined: their steps say `via` which one.
    const outer = this.currentClass;
    const pre = prelude.map((p) => {
      if (p.cls) this.currentClass = p.cls;
      const r = this.analyzeFn(p.fn, new Set([p.fn]));
      this.currentClass = outer;
      return { p, r };
    });
    const result = this.analyzeFn(fn, new Set([fn]));
    this.trace = outerTrace;
    for (const { p, r } of pre.reverse()) {
      // Marked as the pipeline's, so a reviewer can fold cross-cutting code (metrics, logging) out of the business flow.
      result.steps.unshift(...r.steps.map((s) => ({ ...s, via: s.via ?? p.name, ...(p.label ? { pipeline: p.label } : {}) })));
      result.edges.push(...r.edges);
      result.parts.unshift({ name: p.name, role: p.label ? 'pipeline' : 'handler', file: this.rel(p.fn.getSourceFile().getFilePath()), line: p.fn.getStartLineNumber(), text: p.fn.getText() }, ...r.parts);
    }
    trace.label(result.steps);
    const { explain, gaps } = trace.finish();
    (this.snapshot.explain ??= {})[id] = explain;
    this.gapsOf.set(id, gaps);
    const preludeFunctions = pre.filter(({ p }) => p.item >= 0).map(({ p, r }) => ({ item: p.item, functions: [p.name, ...r.parts.map((x) => x.name)] }));
    const edges = [...result.edges];
    for (const [producer, labels] of result.returns) {
      if (producer !== 'entry') edges.push({ from: producer, to: 'exit', kind: 'data', label: [...labels].join(', ') || undefined });
    }
    for (const step of result.steps) {
      if (!edges.some((e) => e.from === step.id)) edges.push({ from: step.id, to: 'exit', kind: 'control' });
      if (!edges.some((e) => e.to === step.id)) edges.push({ from: 'entry', to: step.id, kind: 'control' });
    }
    let returnType = unwrapPromise(fn.getReturnType());
    // Express-style handlers return nothing and answer through `res.json(x)`; the last one is usually the happy path.
    if (result.responses.length && /^(void|any|undefined)$/.test(returnType.getText())) returnType = result.responses.at(-1)!.getType();
    const scope: Scope = {
      id,
      params: this.params(fn),
      returns: this.shape(returnType, fn),
      steps: result.steps,
      edges: mergeEdges(edges),
    };
    const exits = exitsOf(fn, this.rel(fn.getSourceFile().getFilePath()), result.steps);
    if (exits.length) scope.exits = exits;
    this.snapshot.scopes[id] = scope;
    return { scope, result, prelude: preludeFunctions };
  }

  /** Gaps of each scope built so far (calls it could not follow), for its operation or entry point. */
  private gapsOf = new Map<string, Gap[]>();
  private trace = new Trace();

  /**
   * The steps of a function, in the order they run. Every call gets one disposition (see `Trace`): a step, a helper
   * whose steps are inlined, a library call with no side effect, a function value followed to the code it runs, or a
   * gap. Values are followed as far as the code shows them (`Val`): functions handed to a call run where that call
   * runs them (an array method in place, a helper of the project where it calls them, a transaction callback with the
   * transaction's handle), never where they are written; a transaction's steps are those that go through its handle.
   */
  private analyzeFn(fn: Fn, stack: Set<Node>, ctx: Invoke = {}): FnResult {
    const steps: Step[] = [];
    const edges: Edge[] = [];
    const parts: Part[] = [];
    const responses: Node[] = [];
    const env = new Env(ctx.env);
    const callProd = new Map<Node, Prod>();
    const callVals = new Map<Node, Val[]>();
    const trace = this.trace;
    let returns: Prod = new Map();
    const returned: Val[] = [];
    // `@Transactional()`: the framework opens a transaction around the method; all of it runs inside, helpers too.
    const ambient = (Node.isMethodDeclaration(fn) && fn.getDecorators().some((d) => /^Transactional$/i.test(d.getName())) ? '@Transactional' : undefined) ?? ctx.ambient;
    fn.getParameters().forEach((p, i) => {
      const given = ctx.args?.[i] ?? [];
      destructure(p.getNameNode(), given, (name, vals) => env.define(name, new Map([['entry', new Set()]]), vals));
    });
    const body = fn.getBody();
    if (!body) return { steps, edges, returns, parts, responses, vals: returned };

    const prodOf = (node: Node | undefined): Prod => {
      if (!node) return new Map();
      node = unwrap(node);
      if (callProd.has(node)) return callProd.get(node)!;
      if (Node.isIdentifier(node)) return relabel(env.prod(node.getText()), node.getText());
      if (Node.isShorthandPropertyAssignment(node)) return relabel(env.prod(node.getName()), node.getName());
      if (Node.isPropertyAssignment(node)) return prodOf(node.getInitializer());
      if (Node.isPropertyAccessExpression(node)) {
        const root = rootIdentifier(node);
        if (root && env.prod(root)?.has('entry')) return new Map([['entry', new Set([short(node.getText(), 40)])]]);
        return prodOf(node.getExpression());
      }
      // A function literal is a value: what it closes over flows in when it runs, not here.
      if (isFnNode(node)) return new Map();
      const out: Prod = new Map();
      node.forEachChild((child) => mergeInto(out, prodOf(child)));
      return out;
    };

    /** What the code shows a value to be: functions, transaction handles, objects and lists of them. */
    const valOf = (node: Node | undefined, depth = 0): Val[] => {
      if (!node || depth > 12) return [];
      let n = node;
      while (Node.isParenthesizedExpression(n) || Node.isAsExpression(n) || Node.isNonNullExpression(n) || Node.isSatisfiesExpression(n) || Node.isTypeAssertion(n)) n = n.getExpression();
      const next = (x: Node | undefined) => valOf(x, depth + 1);
      if (Node.isAwaitExpression(n)) {
        const inner = n.getExpression();
        // What an awaited call on a handle gives back is data (rows, a count), not the handle.
        const innerCallee = Node.isCallExpression(inner) ? inner.getExpression() : undefined;
        if (innerCallee && Node.isPropertyAccessExpression(innerCallee) && !callVals.has(inner) && handlesIn(next(innerCallee.getExpression())).length) return [];
        return next(inner).filter((v) => !(v.k === 'handle' && Node.isCallExpression(inner) && v.result));
      }
      if (callVals.has(n)) return callVals.get(n)!;
      if (Node.isArrowFunction(n) || Node.isFunctionExpression(n)) return [{ k: 'fn', fn: n, env }];
      if (Node.isIdentifier(n)) {
        const name = n.getText();
        if (env.has(name)) return env.val(name);
        const decl = this.resolveDeclaration(n);
        if (!decl || !this.isProjectFile(decl.getSourceFile().getFilePath())) return [];
        if (isFn(decl)) return decl.getBody() ? [{ k: 'fn', fn: decl }] : [];
        // A module-level constant of the service (`const HANDLERS = { a: () => … }`).
        return Node.isVariableDeclaration(decl) && Node.isSourceFile(decl.getVariableStatement()?.getParent()) ? next(decl.getInitializer()) : [];
      }
      if (Node.isPropertyAccessExpression(n)) {
        const recv = n.getExpression();
        if (recv.getKind() === SyntaxKind.ThisKeyword) return this.fieldVals(n);
        return member(next(recv), n.getName());
      }
      if (Node.isElementAccessExpression(n)) {
        const key = this.literal(n.getArgumentExpressionOrThrow());
        return next(n.getExpression()).flatMap((v) => {
          if (v.k === 'arr') return /^\d+$/.test(key) && v.items[Number(key)] ? v.items[Number(key)] : v.items.flat();
          if (v.k === 'obj') return v.props.get(key) ?? [...v.props.values()].flat();
          return v.k === 'handle' ? [v] : [];
        });
      }
      if (Node.isObjectLiteralExpression(n)) {
        const props = new Map<string, Val[]>();
        for (const p of n.getProperties()) {
          if (Node.isPropertyAssignment(p)) props.set(p.getName(), next(p.getInitializer()));
          else if (Node.isShorthandPropertyAssignment(p)) props.set(p.getName(), env.has(p.getName()) ? env.val(p.getName()) : next(p.getNameNode()));
          else if (Node.isMethodDeclaration(p)) props.set(p.getName(), [{ k: 'fn', fn: p, env }]);
          else if (Node.isSpreadAssignment(p)) for (const v of next(p.getExpression())) if (v.k === 'obj') for (const [k, x] of v.props) props.set(k, x);
        }
        return [{ k: 'obj', props }];
      }
      if (Node.isArrayLiteralExpression(n)) {
        const items: Val[][] = [];
        for (const e of n.getElements()) {
          if (Node.isSpreadElement(e)) items.push(...next(e.getExpression()).flatMap((v) => (v.k === 'arr' ? v.items : [])));
          else items.push(next(e));
        }
        return [{ k: 'arr', items }];
      }
      if (Node.isConditionalExpression(n)) return [...next(n.getWhenTrue()), ...next(n.getWhenFalse())];
      if (Node.isBinaryExpression(n) && [SyntaxKind.QuestionQuestionToken, SyntaxKind.BarBarToken, SyntaxKind.AmpersandAmpersandToken].includes(n.getOperatorToken().getKind())) {
        return [...next(n.getLeft()), ...next(n.getRight())];
      }
      if (Node.isCallExpression(n)) {
        // Not run yet (a call inside an argument being read early): only what needs no running.
        const callee = n.getExpression();
        if (isPromiseAll(n) || /^Promise\.resolve$/.test(callee.getText())) return next(n.getArguments()[0]);
        if (Node.isPropertyAccessExpression(callee)) {
          const recv = next(callee.getExpression());
          if (callee.getName() === 'bind') return recv.filter((v) => v.k === 'fn');
          const h = handlesIn(recv, 0);
          if (h.length) return h.map((tx) => ({ k: 'handle', tx, result: true }) as Val);
          return arrayResult(callee.getName(), recv, []);
        }
      }
      return [];
    };

    const bind = (nameNode: Node, init: Node | undefined, how: 'define' | 'assign' | 'each') => {
      if (!init) return;
      const value = unwrap(init);
      if (Node.isArrayBindingPattern(nameNode) && isPromiseAll(value)) {
        const items = (value as CallExpression).getArguments()[0];
        if (Node.isArrayLiteralExpression(items)) {
          nameNode.getElements().forEach((el, i) => {
            if (Node.isBindingElement(el)) bind(el.getNameNode(), items.getElements()[i], how);
          });
          return;
        }
      }
      const produced = strip(prodOf(init));
      let vals = valOf(init);
      if (how === 'each') vals = vals.flatMap((v) => (v.k === 'arr' ? v.items.flat() : v.k === 'obj' ? [] : []));
      destructure(nameNode, vals, (name, v) => (how === 'assign' ? env.assign(name, produced, v) : env.define(name, produced, v)));
    };

    const where = (node: Node) => ({ file: this.rel(node.getSourceFile().getFilePath()), line: node.getStartLineNumber() });
    const at = (node: Node) => {
      const w = where(node);
      return `${w.file}:${w.line}`;
    };

    /** Runs `v` (a function value) here, with these arguments: its steps are this call's. */
    const invoke = (call: Invocation, v: Extract<Val, { k: 'fn' }>, args: Val[][], guard: Guard, inputs: Map<string, Set<string>>, extra: { loop?: boolean; via?: string } = {}) => {
      // A method of a class given as a value (`items.forEach(this.process)`): as if called.
      if (Node.isMethodDeclaration(v.fn) && !v.env) {
        const r = this.resolveMethod(v.fn);
        if (r.kind === 'op') return handleTarget(call, r, { ...guard, loop: guard.loop || extra.loop || undefined }, new Map(), inputs, args);
      }
      if (stack.has(v.fn)) return;
      stack.add(v.fn);
      const sub = this.analyzeFn(v.fn, stack, { env: v.env, args, ambient });
      stack.delete(v.fn);
      const handed = trace.handed.get(v.fn);
      if (handed) handed.to.push(at(call));
      merge(call, sub, extra.via, { ...guard, loop: guard.loop || extra.loop || undefined }, inputs);
    };

    /** Steps of a function run by this call (a helper, a callback), merged into this one's. */
    const merge = (call: Invocation, sub: FnResult, via: string | undefined, guard: Guard, inputs: Map<string, Set<string>>) => {
      for (const s of sub.steps) {
        steps.push({
          ...s,
          condition: [guard.condition, s.condition].filter(Boolean).join(' and ') || undefined,
          loop: guard.loop || s.loop || undefined,
          ...(s.via ?? via ? { via: s.via ?? via } : {}),
        });
      }
      for (const e of sub.edges) {
        if (e.from !== 'entry') edges.push(e);
        else if (inputs.size === 0) edges.push(e);
        else for (const [producer, labels] of inputs) edges.push({ from: producer, to: e.to, kind: 'data', label: [...labels].join(', ') || e.label });
      }
      const result: Prod = new Map();
      for (const [producer, labels] of sub.returns) {
        if (producer === 'entry') mergeInto(result, inputs);
        else result.set(producer, labels);
      }
      produced(call, result);
      callVals.set(call, [...(callVals.get(call) ?? []), ...sub.vals]);
      responses.push(...sub.responses);
    };

    const produced = (call: Invocation, prod: Prod) => {
      const prev = callProd.get(call);
      if (prev) mergeInto(prev, prod);
      else callProd.set(call, prod);
    };

    const handleCall = (call: Invocation) => {
      trace.clock++;
      const w = { ...where(call), text: short(call.getText(), 100) };
      const callee = call.getExpression();
      const args = call.getArguments();
      const { guardNodes, ...guard } = guardOf(call, fn);
      const guards: Prod = new Map();
      for (const g of guardNodes) mergeInto(guards, strip(prodOf(g)));
      const inputs = new Map<string, Set<string>>();
      for (const arg of args) mergeInto(inputs, prodOf(arg));
      const argVals = args.map((a) => valOf(a));
      // Function literals handed to the call: where they run is decided below, or they are a gap.
      for (const lit of literalsIn(args)) if (!trace.handed.has(lit)) trace.handed.set(lit, { ...where(lit), text: `${calleeName(call) || short(callee.getText(), 30)}(… ${short(lit.getText(), 60)} …)`, to: [] });

      // 1. A call through a value: a parameter, a local, an item of a list (`for (const run of runs) await run(x)`).
      const local = Node.isIdentifier(callee) && env.has(callee.getText());
      const resolved = local ? ({ kind: 'unknown' } as Resolved) : this.resolve(call);
      if (resolved.kind === 'unknown') {
        const viaCall = Node.isPropertyAccessExpression(callee) && callee.getName() === 'call' ? callee.getExpression() : undefined;
        const fns = valOf(viaCall ?? callee).filter((v): v is Extract<Val, { k: 'fn' }> => v.k === 'fn');
        if (fns.length) {
          const given = viaCall ? argVals.slice(1) : argVals;
          for (const v of fns) invoke(call, v, given, guard, inputs);
          trace.note({ ...w, disposition: 'followed', to: [...new Set(fns.map((v) => at(v.fn)))].join(', ') });
          return;
        }
        if (local) {
          trace.note({ ...w, disposition: 'gap', reason: 'function-value' });
          return;
        }
      }

      // 2. An interface whose implementations the module wiring lists (`@Inject(TOKEN) steps: Step[]`): each of them.
      if (resolved.kind === 'unknown' && Node.isPropertyAccessExpression(callee)) {
        const impls = [...new Set(valOf(callee.getExpression()).flatMap((v) => (v.k === 'impl' ? [v.cls] : [])))];
        const methods = impls.map((c) => methodOf(c, callee.getName())).filter((m): m is MethodDeclaration => !!m);
        if (methods.length) {
          for (const m of methods) {
            const cls = m.getParent() as ClassDeclaration;
            const condition = methods.length > 1 ? [guard.condition, `when ${short(callee.getExpression().getText(), 30)} is ${cls.getName()}`].filter(Boolean).join(' and ') : guard.condition;
            handleTarget(call, this.resolveMethod(m), { ...guard, condition }, guards, inputs, argVals);
          }
          trace.note({ ...w, disposition: 'followed', to: methods.map((m) => at(m)).join(', ') });
          return;
        }
      }

      // 3. A library's transaction API: a handle (`createQueryRunner()`), begin and commit on it, a callback it runs
      //    in a transaction with the handle (`manager.transaction(async (em) => …)`).
      const api = resolved.kind === 'unknown' ? this.transactionApi(call) : undefined;
      if (api) {
        const recv = Node.isPropertyAccessExpression(callee) ? valOf(callee.getExpression()) : [];
        if (api.op === 'handle') {
          const source = recv.flatMap((v) => (v.k === 'source' ? [v.node] : []))[0] ?? (Node.isPropertyAccessExpression(callee) ? callee.getExpression() : undefined);
          const tx: Tx = { name: (source && this.dataSourceName(source)) || lastName(callee), begun: false, from: trace.clock };
          trace.txs.push(tx);
          callVals.set(call, [{ k: 'handle', tx }]);
        } else if (api.op === 'begin') {
          for (const tx of handlesIn(recv, 0)) Object.assign(tx, { begun: true, from: trace.clock, to: undefined });
        } else if (api.op === 'commit') {
          for (const tx of handlesIn(recv, 0)) if (tx.begun && tx.to === undefined) tx.to = trace.clock;
        } else if (api.op === 'callback') {
          const tx: Tx = { name: short(callee.getText().replace(/^this\./, ''), 40), fixed: true, begun: true, from: trace.clock };
          trace.txs.push(tx);
          for (const vals of argVals) for (const v of vals) if (v.k === 'fn') invoke(call, v, [[{ k: 'handle', tx }]], guard, inputs);
          tx.to = ++trace.clock;
        }
        trace.note({ ...w, disposition: 'external' });
        return;
      }

      // 4. A library call that runs the function it is given right there: array methods, a promise's continuations,
      //    `new Promise(executor)`, and what the profile's `callbacks` say.
      if (resolved.kind === 'unknown' || resolved.kind === 'response') {
        const name = Node.isNewExpression(call) ? callee.getText() : calleeName(call);
        const recv = Node.isPropertyAccessExpression(callee) ? valOf(callee.getExpression()) : [];
        const rule = this.callbackRule(call);
        const inPlace = ARRAY_CALLBACKS.has(name) || PROMISE_CALLBACKS.has(name) || (Node.isNewExpression(call) && name === 'Promise') || !!rule;
        if (inPlace) {
          const when = rule?.condition ? { ...guard, condition: [guard.condition, rule.condition].filter(Boolean).join(' and ') } : guard;
          const items = recv.flatMap((v) => (v.k === 'arr' ? v.items.flat() : []));
          const results: Val[] = [];
          // The functions given: directly, or in an observer object (`tap({ next: …, error: … })`; `error` runs on error).
          const given = argVals.flat().flatMap((v) => (v.k === 'fn' ? [{ v, onError: false }] : v.k === 'obj' ? [...v.props].flatMap(([k, xs]) => xs.filter((x) => x.k === 'fn').map((x) => ({ v: x, onError: /^error$/i.test(k) }))) : []));
          for (const { v, onError } of given) {
            if (v.k !== 'fn') continue;
            const before = callVals.get(call)?.length ?? 0;
            const guardFor = onError ? { ...when, condition: [when.condition, 'on error'].filter(Boolean).join(' and ') } : when;
            invoke(call, v, ARRAY_CALLBACKS.has(name) ? [items, [], recv] : [], guardFor, inputs, { loop: ARRAY_CALLBACKS.has(name) });
            results.push(...(callVals.get(call) ?? []).slice(before));
          }
          callVals.set(call, ARRAY_CALLBACKS.has(name) ? arrayResult(name, recv, results) : results);
        } else if (isPromiseAll(call)) callVals.set(call, argVals[0] ?? []);
        else if (Node.isPropertyAccessExpression(callee)) {
          const r = arrayResult(callee.getName(), recv, []);
          if (r.length) callVals.set(call, r);
          // A method of a handle gives what works on the same connection (`runner.manager.getRepository(X)`).
          const h = handlesIn(recv, 0);
          if (h.length && !callVals.has(call)) callVals.set(call, h.map((tx) => ({ k: 'handle', tx, result: true })));
        }
        if (resolved.kind === 'response') {
          if (resolved.arg) {
            mergeInto(returns, prodOf(resolved.arg));
            responses.push(resolved.arg);
          }
          trace.note({ ...w, disposition: 'external' });
          return;
        }
        const d = this.unknownCall(call);
        trace.note({ ...w, ...d });
        return;
      }

      // 5. A step, a helper, a bus that runs handlers.
      for (const target of resolved.kind === 'dispatch' ? resolved.targets : [resolved]) handleTarget(call, target, guard, guards, inputs, argVals);
      trace.note({ ...w, disposition: resolved.kind === 'inline' ? 'inlined' : 'step', ...(resolved.kind === 'op' ? { to: resolved.opId } : {}) });
    };

    const handleTarget = (call: Invocation, resolved: Resolved, guard: Guard, guards: Prod, inputs: Map<string, Set<string>>, argVals: Val[][]) => {
      if (resolved.kind === 'op' || resolved.kind === 'sink') {
        const step: Step = {
          id: `s${++this.stepCounter}`,
          kind: resolved.kind === 'op' ? 'call' : 'effect',
          ...(resolved.kind === 'op' ? { target: resolved.opId } : { effect: resolved.effect }),
          line: call.getStartLineNumber(),
          file: this.rel(call.getSourceFile().getFilePath()),
          ...guard,
          ...(ambient ? { transaction: ambient } : {}),
        };
        steps.push(step);
        // In a transaction when it goes through the transaction's handle: as its receiver, or given to it.
        const callee = call.getExpression();
        const through = [...new Set([...(Node.isPropertyAccessExpression(callee) ? handlesIn(valOf(callee.getExpression()), 0) : []), ...argVals.flatMap((v) => handlesIn(v, 0))])].filter((t) => t.begun && t.to === undefined);
        if (through.length) trace.stepTx.set(step.id, through);
        else if (!ambient) {
          const open = trace.txs.filter((t) => t.begun && t.to === undefined);
          if (open.length) trace.outside.set(step.id, open);
        }
        for (const [producer, labels] of inputs) {
          edges.push({ from: producer, to: step.id, kind: 'data', label: [...labels].join(', ') || undefined });
        }
        for (const producer of guards.keys()) {
          if (producer !== 'entry' && !inputs.has(producer)) edges.push({ from: producer, to: step.id, kind: 'control', label: 'guards' });
        }
        produced(call, new Map([[step.id, new Set()]]));
        // A function given to another operation, which calls it (`locks.withLock(key, async () => …)`): its steps run
        // there, right after the call starts.
        if (resolved.kind === 'op') {
          const target = this.findOp(resolved.opId)?.method;
          argVals.forEach((vals, i) => {
            const runAt = target && this.callOfParam(target, i);
            if (!runAt) return;
            for (const v of vals) if (v.k === 'fn') {
              invoke(call, v, [], guard, new Map(), { via: resolved.opId });
              const handed = trace.handed.get(v.fn);
              if (handed) handed.to.splice(-1, 1, at(runAt));
            }
          });
        }
      } else if (resolved.kind === 'inline' && !stack.has(resolved.fn)) {
        stack.add(resolved.fn);
        const sub = this.analyzeFn(resolved.fn, stack, { args: argVals, ambient });
        stack.delete(resolved.fn);
        parts.push({ name: resolved.name, role: 'helper', file: this.rel(resolved.fn.getSourceFile().getFilePath()), line: resolved.fn.getStartLineNumber(), text: resolved.fn.getText() }, ...sub.parts);
        merge(call, sub, resolved.name, guard, inputs);
      }
    };

    // Statements run in order; code inside a function literal runs when (and where) that function is run.
    const nodes = [body, ...body.getDescendants()].filter((n) => n === body || !insideNested(n, body));
    const events = nodes.filter(
      (n) =>
        Node.isCallExpression(n) ||
        Node.isNewExpression(n) && (this.rules.sinks.some((r) => methodsOf(r).includes('new')) || n.getExpression().getText() === 'Promise' || literalsIn(n.getArguments()).length > 0) ||
        Node.isVariableDeclaration(n) ||
        Node.isBinaryExpression(n) && n.getOperatorToken().getKind() === SyntaxKind.EqualsToken ||
        Node.isReturnStatement(n),
    );
    events.sort((a, b) => a.getEnd() - b.getEnd() || rank(a) - rank(b));
    for (const ev of events) {
      if (Node.isCallExpression(ev) || Node.isNewExpression(ev)) handleCall(ev);
      else if (Node.isVariableDeclaration(ev)) {
        const loop = ev.getParent()?.getParent();
        const each = Node.isForOfStatement(loop) || Node.isForInStatement(loop);
        bind(ev.getNameNode(), each ? loop.getExpression() : ev.getInitializer(), each && Node.isForOfStatement(loop) ? 'each' : 'define');
      }
      else if (Node.isBinaryExpression(ev)) bind(ev.getLeft(), ev.getRight(), 'assign');
      else if (Node.isReturnStatement(ev)) {
        mergeInto(returns, prodOf(ev.getExpression()));
        returned.push(...valOf(ev.getExpression()));
      }
    }
    if (!Node.isBlock(body)) {
      returns = prodOf(body);
      returned.push(...valOf(body));
    }
    return { steps, edges, returns, parts, responses, vals: returned };
  }

  /** The library transaction API a call is, by the adapters' `transactions` rules (matched on the library's declaration). */
  private transactionApi(call: Invocation): { op: 'handle' | 'begin' | 'commit' | 'rollback' | 'callback' } | undefined {
    if (Node.isNewExpression(call)) return undefined;
    const site = this.site(call);
    const name = calleeName(call);
    for (const t of this.rules.transactions) {
      if (!site || !site.pkg || !t.module.split('|').includes(site.pkg)) continue;
      for (const op of ['handle', 'begin', 'commit', 'rollback', 'callback'] as const) if (t[op]?.includes(name)) return { op };
    }
    // Any other library's `transaction(cb)` / `$transaction(cb)` (Sequelize, Knex, …): a callback transaction.
    if (/^\$?transaction$/i.test(name) && literalsIn(call.getArguments()).length) return { op: 'callback' };
    return undefined;
  }

  /** The `callbacks` rule (an adapter's or the profile's) for a library call that runs the function it is given in place. */
  private callbackRule(call: Invocation): CallbackRule | undefined {
    const rules = this.rules.callbacks;
    if (!rules.length || Node.isNewExpression(call)) return undefined;
    const site = this.site(call);
    if (!site) return undefined;
    return rules.find((r) => r.runs === 'in-place' && (r.function ?? r.method) === site.name && (!r.module || r.module.split('|').includes(site.pkg)) && (!r.class || r.class.split('|').includes(site.owner)));
  }

  /** `this.x`: what the class holds there (a data source, by the name it is injected with; a list of implementations). */
  private fieldVals(access: Node): Val[] {
    const ctx = this.hookContext();
    for (const h of this.rules.hooks) {
      const list = h.implementations?.(access, ctx);
      if (list?.length) return [{ k: 'arr', items: list.map((cls) => [{ k: 'impl', cls } as Val]) }];
    }
    const decl = Node.isPropertyAccessExpression(access) ? this.resolveDeclaration(access) : undefined;
    if (decl && Node.isMethodDeclaration(decl) && decl.getBody() && this.isProjectFile(decl.getSourceFile().getFilePath())) return [{ k: 'fn', fn: decl }];
    return [{ k: 'source', node: access }];
  }

  /** Where a function calls the function it is given as parameter `index` (`retry(op)` runs `op()`), if it does. */
  private callOfParam(fn: Fn, index: number): CallExpression | undefined {
    const p = fn.getParameters()[index];
    if (!p || !Node.isIdentifier(p.getNameNode())) return undefined;
    return fn.getDescendantsOfKind(SyntaxKind.CallExpression).find((c) => Node.isIdentifier(c.getExpression()) && c.getExpression().getText() === p.getName() && this.resolveDeclaration(c.getExpression()) === p);
  }

  /**
   * A call that is no step, no helper and no function value: a library call (`external`), or one the analysis can't
   * follow (a gap): a method only declared in the project (an interface or abstract method the wiring doesn't bind),
   * a function-typed property or parameter, a computed callee (`handlers[type](…)`), or a dependency with no types.
   */
  private unknownCall(call: Invocation): { disposition: 'external' } | { disposition: 'gap'; reason: GapReason } {
    const callee = call.getExpression();
    if (Node.isNewExpression(call)) return { disposition: 'external' };
    if (Node.isElementAccessExpression(callee)) return { disposition: 'gap', reason: 'dynamic' };
    const decl = this.resolveDeclaration(callee);
    if (decl && this.isProjectFile(decl.getSourceFile().getFilePath())) {
      if (Node.isMethodSignature(decl) || (Node.isMethodDeclaration(decl) && !decl.getBody())) {
        return { disposition: 'gap', reason: Node.isInterfaceDeclaration(decl.getParent()) || Node.isClassDeclaration(decl.getParent()) ? 'interface-dispatch' : 'function-value' };
      }
      if (Node.isPropertySignature(decl) || Node.isPropertyDeclaration(decl) || Node.isParameterDeclaration(decl) || Node.isVariableDeclaration(decl) || Node.isBindingElement(decl)) return { disposition: 'gap', reason: 'function-value' };
      return { disposition: 'external' };
    }
    if (!decl) {
      // A dependency of the class with no types (`this.client.send(…)` on `any`): what it does is unknown.
      const recv = Node.isPropertyAccessExpression(callee) ? callee.getExpression() : undefined;
      let root: Node | undefined = recv;
      while (root && (Node.isPropertyAccessExpression(root) || Node.isCallExpression(root) || Node.isElementAccessExpression(root))) root = root.getExpression();
      if (recv && root?.getKind() === SyntaxKind.ThisKeyword && recv.getType().isAny()) return { disposition: 'gap', reason: 'untyped' };
      if (Node.isIdentifier(callee) && callee.getType().isAny()) return { disposition: 'gap', reason: 'untyped' };
    }
    return { disposition: 'external' };
  }

  /**
   * The data source a query runner (or transaction context) comes from: followed through variables, `ctx.queryRunner`,
   * `contexts[0]` of a `Promise.all([...])`, `createQueryRunner()`, and helpers given the data source, to a field
   * injected with a name (`@InjectDataSource('orders')`), else the field's own name.
   */
  private dataSourceName(node: Node, depth = 0): string | undefined {
    if (depth > 10) return undefined;
    const n = unwrap(node);
    const next = (x: Node | undefined) => (x ? this.dataSourceName(x, depth + 1) : undefined);
    if (Node.isAwaitExpression(n)) return next(n.getExpression());
    if (Node.isIdentifier(n)) {
      const decl = this.resolveDeclaration(n);
      if (decl && Node.isVariableDeclaration(decl)) return next(decl.getInitializer());
      if (decl && Node.isBindingElement(decl)) {
        // const [orders, audit] = await Promise.all([...])
        const pattern = decl.getParent();
        const v = pattern?.getParent();
        if (Node.isArrayBindingPattern(pattern) && Node.isVariableDeclaration(v)) return next(this.elementOf(v.getInitializer(), pattern.getElements().indexOf(decl)));
      }
      return undefined;
    }
    if (Node.isPropertyAccessExpression(n)) {
      if (unwrap(n.getExpression()).getKind() !== SyntaxKind.ThisKeyword) return next(n.getExpression());
      const decl = this.resolveDeclaration(n);
      if (decl && (Node.isParameterDeclaration(decl) || Node.isPropertyDeclaration(decl))) {
        for (const d of decl.getDecorators()) for (const a of d.getArguments()) if (Node.isStringLiteral(a)) return a.getLiteralValue();
      }
      return n.getName();
    }
    if (Node.isElementAccessExpression(n)) {
      const index = Number(this.literal(n.getArgumentExpressionOrThrow()));
      const holder = unwrap(n.getExpression());
      const decl = Node.isIdentifier(holder) ? this.resolveDeclaration(holder) : undefined;
      const item = Number.isInteger(index) && decl && Node.isVariableDeclaration(decl) ? this.elementOf(decl.getInitializer(), index) : undefined;
      return next(item ?? holder);
    }
    if (Node.isCallExpression(n)) {
      const callee = n.getExpression();
      if (calleeName(n) === 'createQueryRunner' && Node.isPropertyAccessExpression(callee)) return next(callee.getExpression());
      for (const a of n.getArguments()) {
        const v = next(a);
        if (v) return v;
      }
      return Node.isPropertyAccessExpression(callee) ? next(callee.getExpression()) : undefined;
    }
    if (Node.isObjectLiteralExpression(n)) {
      for (const p of n.getProperties()) {
        const v = Node.isPropertyAssignment(p) ? next(p.getInitializer()) : Node.isShorthandPropertyAssignment(p) ? next(p.getNameNode()) : undefined;
        if (v) return v;
      }
    }
    return undefined;
  }

  /** Item `index` of an array a variable holds: `[a, b]`, or what `await Promise.all([a, b])` resolves to. */
  private elementOf(init: Node | undefined, index: number): Node | undefined {
    let v = init && unwrap(init);
    if (v && Node.isAwaitExpression(v)) v = unwrap(v.getExpression());
    if (v && isPromiseAll(v)) v = unwrap((v as CallExpression).getArguments()[0]);
    return v && Node.isArrayLiteralExpression(v) ? v.getElements()[index] : undefined;
  }

  // ---------- resolution ----------

  private resolve(call: Invocation): Resolved {
    const site = this.site(call);
    if (site && (site.owner || site.pkg)) {
      const effect = this.sinkEffect(site);
      if (effect) {
        const lock = effect.kind === 'db.read' ? lockOf(call) : undefined;
        return { kind: 'sink', effect: { ...effect, ...(lock ? { lock } : {}), file: this.rel(call.getSourceFile().getFilePath()), line: call.getStartLineNumber() } };
      }
      const response = this.rules.responses.find((r) => matches(r, site));
      if (response) return { kind: 'response', arg: call.getArguments()[response.arg] };
      for (const h of this.rules.hooks) {
        const handlers = h.dispatch?.(site, this.hookContext());
        if (handlers?.length) return { kind: 'dispatch', targets: handlers.map((m) => this.resolveMethod(m)) };
      }
    }
    if (Node.isNewExpression(call)) return { kind: 'unknown' };
    if (site && site.owner && site.name !== 'new') {
      const { cls, owner, name, decl } = site;
      const moduleId = cls && this.moduleIds.get(cls);
      // Another operation, in this module or another, is a step of its own (`resolveHold` → `release` / `cancel`):
      // the flow stays one module level deep. Only private helpers are inlined into the caller.
      if (cls && moduleId && Node.isMethodDeclaration(decl) && this.isOperation(decl) && decl.getParent() === cls) {
        return { kind: 'op', opId: this.opIdOf(cls, name) };
      }
      if (Node.isMethodDeclaration(decl) && decl.getBody() && this.isProjectFile(decl.getSourceFile().getFilePath())) {
        return { kind: 'inline', fn: decl, name: `${owner}.${name}` };
      }
      return { kind: 'unknown' };
    }
    const decl = this.resolveDeclaration(call.getExpression());
    if (decl && isFn(decl) && decl.getBody() && this.isProjectFile(decl.getSourceFile().getFilePath())) {
      const name = Node.isFunctionDeclaration(decl) ? decl.getName() ?? 'fn' : call.getExpression().getText();
      return { kind: 'inline', fn: decl, name };
    }
    return { kind: 'unknown' };
  }

  /** A method the code reaches without a direct call (a bus handler): an operation step, or inlined. */
  private resolveMethod(method: MethodDeclaration): Resolved {
    const cls = method.getParent();
    if (Node.isClassDeclaration(cls) && this.moduleIds.has(cls) && this.isOperation(method)) return { kind: 'op', opId: this.opIdOf(cls, method.getName()) };
    if (method.getBody() && this.isProjectFile(method.getSourceFile().getFilePath())) {
      return { kind: 'inline', fn: method, name: `${Node.isClassDeclaration(cls) ? cls.getName() : 'class'}.${method.getName()}` };
    }
    return { kind: 'unknown' };
  }

  private sinkEffect(site: Site): Omit<Effect, 'file' | 'line'> | undefined {
    for (const h of this.rules.hooks) {
      const effect = h.sink?.(site, this.hookContext());
      if (effect) return effect;
    }
    const rule = this.rules.sinks.find((r) => matches(r, site));
    if (!rule) return undefined;
    const spec = rule.target ?? `arg:${rule.targetArg ?? 0}`;
    for (const alt of spec.split('|')) {
      const target = this.targetBy(alt, site);
      if (target && target !== '?') return { kind: rule.kind, target };
    }
    return { kind: rule.kind, target: '?' };
  }

  /** Names the table/topic/service of a side effect; see SinkRule in config.ts for the strategies. */
  private targetBy(spec: string, site: Site): string | undefined {
    const args = site.call.getArguments();
    if (spec.startsWith('const:')) return spec.slice(6);
    if (spec.startsWith('arg:')) {
      const node = argNode(args, spec.slice(4));
      return node ? this.targetText(node) : undefined;
    }
    if (spec.startsWith('url:')) return this.urlTarget(argNode(args, spec.slice(4)));
    if (spec === 'receiver') return site.receiver && Node.isPropertyAccessExpression(site.receiver) ? site.receiver.getName() : site.receiver?.getText();
    if (spec === 'injected') return this.injectedName(site.receiver);
    if (spec === 'entity') {
      const typeArg = site.receiver?.getType().getTypeArguments()[0];
      // The entity class passed (`manager.update(Order, …)`), else the argument's type: an entity, or an array of them
      // (`manager.save(rows)` with `rows = items.map((i) => repo.create({…}))`, or `manager.create(Order, …)` items).
      const argType = args[0]?.getType().getNonNullableType();
      const element = argType?.isArray() ? argType.getArrayElementType() : argType;
      const fromArg = args[0] && (this.classOf(args[0]) ?? element?.getSymbol()?.getDeclarations()[0]);
      const decl = typeArg?.getSymbol()?.getDeclarations()[0] ?? fromArg;
      return decl && Node.isClassDeclaration(decl) ? entityTable(decl, (n) => this.literal(n)) : undefined;
    }
    if (spec === 'model') {
      const injected = this.injectedName(site.receiver);
      const name = injected ?? site.receiver?.getType().getTypeArguments()[0]?.getSymbol()?.getName();
      return name ? collectionName(name) : undefined;
    }
    return undefined;
  }

  /**
   * What a side effect's target argument names, followed back to where the value is made: a local variable or a
   * `this.x` field set in the constructor to its value, `config.get('TOPICS').X` to the config key
   * (`TOPICS.X`), a message built by a factory to the string the factory was given
   * (`buildMessage(id, 'OrderShipped')`), an object to its `topic` / `type`, and a parameter to what
   * the service's callers pass. Else `<the expression>`.
   */
  private targetText(node: Node | undefined, depth = 0, seen = new Set<Node>()): string {
    if (!node) return '?';
    const lit = this.literal(node);
    if (!lit.startsWith('<') || depth > 6 || seen.has(node)) return lit;
    seen.add(node);
    const n = unwrap(node);
    const next = (x: Node | undefined) => (x ? this.targetText(x, depth + 1, seen) : undefined);
    const found = (v: string | undefined) => v !== undefined && v !== '?' && !v.startsWith('<');
    const key = configKey(n, (x) => this.literal(x));
    if (key) return key;
    if (Node.isAwaitExpression(n)) return next(n.getExpression()) ?? lit;
    if (Node.isTemplateExpression(n)) {
      const parts = [n.getHead().getLiteralText(), ...n.getTemplateSpans().flatMap((s) => [next(s.getExpression()) ?? '?', s.getLiteral().getLiteralText()])];
      return parts.slice(1).every((p, i) => i % 2 === 1 || found(p)) ? parts.join('') : lit;
    }
    if (Node.isIdentifier(n)) {
      const parent = n.getParent();
      const symbol = parent && Node.isShorthandPropertyAssignment(parent) && parent.getNameNode() === n ? parent.getValueSymbol() : n.getSymbol();
      const decl = symbol?.getDeclarations()[0];
      if (decl && Node.isVariableDeclaration(decl)) return next(decl.getInitializer()) ?? lit;
      if (decl && Node.isParameterDeclaration(decl)) return this.fromCallers(decl, undefined, depth, seen) ?? `<${decl.getName()} from the caller>`;
      return lit;
    }
    if (Node.isPropertyAccessExpression(n)) {
      const holder = unwrap(n.getExpression());
      if (holder.getKind() === SyntaxKind.ThisKeyword) {
        const v = next(this.fieldValue(n));
        return v && found(v) ? v : lit;
      }
      if (Node.isIdentifier(holder)) {
        const decl = holder.getSymbol()?.getDeclarations()[0];
        if (decl && Node.isParameterDeclaration(decl)) return this.fromCallers(decl, n.getName(), depth, seen) ?? `<${n.getText()} from the caller>`;
        const value = argNode([holder], `0.${n.getName()}`);
        if (value) return next(value) ?? lit;
      }
      return lit;
    }
    if (Node.isObjectLiteralExpression(n)) {
      for (const prop of ['topic', 'type', 'eventType', 'event', 'name']) {
        const value = argNode([n], `0.${prop}`);
        const v = next(value);
        if (found(v)) return v!;
      }
      return lit;
    }
    if (Node.isCallExpression(n)) {
      // A factory that builds the message: the string it is given names it.
      const strings = n.getArguments().map((a) => this.literal(a)).filter((v) => /^[A-Za-z][\w.:-]*$/.test(v));
      if (strings.length) return strings.at(-1)!;
    }
    return lit;
  }

  /** `this.x`: the value the field is created with, or what the constructor assigns to it. */
  private fieldValue(access: Node): Node | undefined {
    const decl = this.resolveDeclaration(access);
    if (!decl || !Node.isPropertyDeclaration(decl)) return undefined;
    if (decl.getInitializer()) return decl.getInitializer();
    const cls = decl.getParent();
    if (!Node.isClassDeclaration(cls)) return undefined;
    for (const ctor of cls.getConstructors()) {
      for (const bin of ctor.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        const left = bin.getLeft();
        if (bin.getOperatorToken().getKind() === SyntaxKind.EqualsToken && Node.isPropertyAccessExpression(left) && left.getExpression().getKind() === SyntaxKind.ThisKeyword && left.getName() === decl.getName()) return bin.getRight();
      }
    }
    return undefined;
  }

  /** What the service's own callers pass for a parameter (or one property of it): `a | b`, if they say. */
  private fromCallers(param: Node, prop: string | undefined, depth: number, seen: Set<Node>): string | undefined {
    const fn = param.getParent();
    if (!fn || !(Node.isMethodDeclaration(fn) || Node.isFunctionDeclaration(fn)) || depth > 3) return undefined;
    const index = fn.getParameters().indexOf(param as never);
    const files = new Set(this.projectFiles());
    const values = new Set<string>();
    for (const ref of fn.findReferencesAsNodes()) {
      const call = callOf(ref);
      if (!call || !files.has(call.getSourceFile())) continue;
      const arg = argNode(call.getArguments(), prop ? `${index}.${prop}` : String(index));
      const v = arg ? this.targetText(arg, depth + 1, seen) : '?';
      if (v !== '?' && !v.startsWith('<')) values.add(v);
    }
    return values.size ? [...values].sort().join(' | ') : undefined;
  }

  /** The name a receiver was injected or built with: `@InjectQueue('emails') q`, `q = new Queue('emails')`. */
  private injectedName(receiver: Node | undefined): string | undefined {
    if (!receiver) return undefined;
    const decl = this.resolveDeclaration(receiver);
    if (!decl) return undefined;
    if (Node.isParameterDeclaration(decl) || Node.isPropertyDeclaration(decl)) {
      for (const d of decl.getDecorators()) {
        const value = d.getArguments()[0] && this.literal(d.getArguments()[0]);
        if (value && !value.startsWith('<')) return value;
      }
    }
    const init = Node.isPropertyDeclaration(decl) || Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
    if (init && Node.isNewExpression(init) && init.getArguments()[0]) {
      const value = this.literal(init.getArguments()[0]);
      if (!value.startsWith('<')) return value;
    }
    if (init && Node.isCallExpression(init) && init.getArguments()[0]) {
      const value = this.literal(init.getArguments()[0]);
      if (!value.startsWith('<')) return value;
    }
    return undefined;
  }

  private classOf(node: Node): ClassDeclaration | undefined {
    const decl = Node.isIdentifier(node) ? this.resolveDeclaration(node) : undefined;
    return decl && Node.isClassDeclaration(decl) ? decl : undefined;
  }

  /** Host for absolute URLs; the path with `{name}` for interpolated parts otherwise. */
  private urlTarget(node: Node | undefined): string | undefined {
    if (!node) return undefined;
    const text = this.urlText(node);
    if (text === undefined) return undefined;
    const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(text);
    return m ? m[1] : text.replace(/[?#].*$/, '');
  }

  /**
   * A URL as a template, followed back to where its parts are made, as `targetText` does for topics: a local
   * variable or a `this.x` field set in the constructor to its value, a config key in braces
   * (`configService.getOrThrow('PAYMENTS_URL')` → `{PAYMENTS_URL}`), a parameter as `{its name}`, string `+`.
   * Undefined when it can't be read.
   */
  private urlText(node: Node, depth = 0, seen = new Set<Node>()): string | undefined {
    const value = this.literal(node);
    if (!value.startsWith('<') && value !== '?') return value;
    if (depth > 6 || seen.has(node)) return undefined;
    seen.add(node);
    const n = unwrap(node);
    const next = (x: Node | undefined) => (x ? this.urlText(x, depth + 1, seen) : undefined);
    const key = configKey(n, (x) => this.literal(x));
    if (key) return `{${key}}`;
    if (Node.isAwaitExpression(n)) return next(n.getExpression());
    if (Node.isTemplateExpression(n)) {
      return n.getHead().getLiteralText() + n.getTemplateSpans().map((s) => `${next(s.getExpression()) ?? `{${lastName(s.getExpression())}}`}${s.getLiteral().getLiteralText()}`).join('');
    }
    if (Node.isBinaryExpression(n) && n.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
      return [n.getLeft(), n.getRight()].map((x) => next(x) ?? `{${lastName(x)}}`).join('');
    }
    if (Node.isIdentifier(n)) {
      const parent = n.getParent();
      const symbol = parent && Node.isShorthandPropertyAssignment(parent) && parent.getNameNode() === n ? parent.getValueSymbol() : n.getSymbol();
      const decl = symbol?.getDeclarations()[0];
      if (decl && Node.isVariableDeclaration(decl)) return next(decl.getInitializer());
      if (decl && Node.isParameterDeclaration(decl)) return `{${decl.getName()}}`;
      // `const { baseUrl } = config.get('IDENTITY_CONFIG')`: that property of the config value.
      const pattern = decl && Node.isBindingElement(decl) ? decl.getParent() : undefined;
      const holder = pattern && Node.isObjectBindingPattern(pattern) ? pattern.getParent() : undefined;
      if (decl && Node.isBindingElement(decl) && holder && Node.isVariableDeclaration(holder)) return member(next(holder.getInitializer()), decl.getPropertyNameNode()?.getText() ?? decl.getName());
      return undefined;
    }
    if (Node.isPropertyAccessExpression(n)) {
      if (unwrap(n.getExpression()).getKind() === SyntaxKind.ThisKeyword) return next(this.fieldValue(n));
      // `config.baseUrl`, where `config` holds a config value: `{CONFIG_KEY.baseUrl}`.
      return member(next(n.getExpression()), n.getName());
    }
    return undefined;

    /** A property of a config value in braces is a longer key; of anything else, unknown. */
    function member(of: string | undefined, prop: string): string | undefined {
      return of && /^\{[^{}]+\}$/.test(of) ? `${of.slice(0, -1)}.${prop}}` : undefined;
    }
  }

  /**
   * Resolves a call to who declares what it calls: `x.method()` to its class (following interfaces to their single
   * module implementation), interface or type alias; `fn()` / `ns.fn()` to the function and its npm package.
   */
  private site(call: Invocation): Site | undefined {
    const own = this.thisSite(call);
    if (own) return own;
    if (this.siteCache.has(call)) return this.siteCache.get(call);
    const site = this.computeSite(call);
    if (site?.receiver && site.name !== 'new') {
      const symbol = site.receiver.getType().getSymbol();
      const decl = symbol?.getDeclarations()[0];
      if (symbol && decl && Node.isClassDeclaration(decl) && symbol.getName() !== site.owner) {
        site.receiverClass = symbol.getName();
        site.receiverPkg = pkgOf(decl.getSourceFile().getFilePath());
      }
    }
    this.siteCache.set(call, site);
    return site;
  }

  /**
   * `this.x()` in a base class method that runs as a subclass (an inherited consumer handler calling its abstract
   * `this.syncFeature()`): `x` as that subclass has it. Not cached: the same call means another method per subclass.
   */
  private thisSite(call: Invocation): Site | undefined {
    const cur = this.currentClass;
    if (!cur || Node.isNewExpression(call)) return undefined;
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr) || expr.getExpression().getKind() !== SyntaxKind.ThisKeyword) return undefined;
    const own = call.getFirstAncestor((n) => Node.isClassDeclaration(n)) as ClassDeclaration | undefined;
    if (!own || own === cur || !isSubclassOf(cur, own)) return undefined;
    const method = methodOf(cur, expr.getName());
    const cls = method?.getParent();
    if (!method || !cls || cls === own || !Node.isClassDeclaration(cls)) return undefined;
    return { call, cls, owner: cls.getName() ?? 'Anonymous', name: method.getName(), pkg: pkgOf(method.getSourceFile().getFilePath()), decl: method, receiver: expr.getExpression() };
  }

  private computeSite(call: Invocation): Site | undefined {
    const expr = call.getExpression();
    const receiver = Node.isPropertyAccessExpression(expr) ? expr.getExpression() : undefined;
    const decl = this.resolveDeclaration(expr);
    if (!decl) return undefined;
    const pkg = pkgOf(decl.getSourceFile().getFilePath());
    if (Node.isNewExpression(call)) {
      return Node.isClassDeclaration(decl) ? { call, owner: decl.getName() ?? '', name: 'new', pkg, decl, receiver } : undefined;
    }
    if (Node.isFunctionDeclaration(decl)) return { call, owner: '', name: decl.getName() ?? '', pkg, decl, receiver };
    if (!(Node.isMethodDeclaration(decl) || Node.isMethodSignature(decl) || Node.isPropertySignature(decl) || Node.isPropertyDeclaration(decl))) return undefined;
    const name = decl.getName();
    const parent = decl.getParent();
    // Dependency injection may bind the receiver to another class (`@Inject(TOKEN)`, an abstract class token).
    if (receiver && (Node.isInterfaceDeclaration(parent) || Node.isClassDeclaration(parent))) {
      const ctx = this.hookContext();
      for (const h of this.rules.hooks) {
        const bound = h.implementation?.(receiver, ctx);
        const method = bound && methodOf(bound, name);
        if (bound && method) return { call, cls: bound, owner: bound.getName() ?? '', name, pkg: '', decl: method, receiver };
      }
    }
    if (Node.isClassDeclaration(parent) && parent.isAbstract() && Node.isMethodDeclaration(decl) && decl.isAbstract()) {
      // An abstract method: the one module that implements it, as for interfaces.
      const subs = [...this.moduleIds.keys()].filter((c) => c.getBaseClass() === parent);
      const method = subs.length === 1 ? subs[0].getMethod(name) : undefined;
      if (method) return { call, cls: subs[0], owner: subs[0].getName() ?? '', name, pkg, decl: method, receiver };
      return { call, owner: parent.getName() ?? '', name, pkg, decl, receiver };
    }
    if (Node.isInterfaceDeclaration(parent)) {
      const ifaceName = parent.getName();
      const impls = [...this.moduleIds.keys()].filter((c) => c.getImplements().some((i) => i.getExpression().getText() === ifaceName));
      if (impls.length !== 1) return { call, owner: ifaceName, name, pkg, decl, receiver };
      const implMethod = impls[0].getMethod(name);
      return { call, cls: impls[0], owner: impls[0].getName() ?? ifaceName, name, pkg, decl: implMethod ?? decl, receiver };
    }
    if (Node.isClassDeclaration(parent)) return { call, cls: parent, owner: parent.getName() ?? 'Anonymous', name, pkg, decl, receiver };
    if (Node.isTypeLiteral(parent)) {
      // `type Sender = { send(…) }` (kafkajs), or the object type of a namespace-like const (`nodeCron.schedule`).
      const alias = parent.getFirstAncestor((n) => Node.isTypeAliasDeclaration(n));
      return { call, owner: alias && Node.isTypeAliasDeclaration(alias) ? alias.getName() : '', name, pkg, decl, receiver };
    }
    return undefined;
  }

  private resolveDeclaration(node: Node): Node | undefined {
    const nameNode = Node.isPropertyAccessExpression(node) ? node.getNameNode() : node;
    let symbol = nameNode.getSymbol();
    if (!symbol) return undefined;
    if (symbol.isAlias()) symbol = symbol.getAliasedSymbol() ?? symbol;
    const decl = symbol.getDeclarations()[0];
    if (decl && Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      return init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) ? init : decl;
    }
    return decl;
  }

  /** A decorator by name, imported from one of `from` (`@nestjs/common`, or `a|b`). */
  private findDecorator(node: { getDecorators(): Decorator[] }, names: string, from: string): Decorator | undefined {
    const wanted = names.split('|');
    const pkgs = from.split('|');
    return node.getDecorators().find((d) => wanted.includes(d.getName()) && pkgs.includes(this.decoratorPkg(d)));
  }

  private decoratorPkg(d: Decorator): string {
    const sf = d.getSourceFile();
    const name = d.getName();
    for (const imp of sf.getImportDeclarations()) {
      if (imp.getNamedImports().some((n) => (n.getAliasNode()?.getText() ?? n.getName()) === name)) return packageRoot(imp.getModuleSpecifierValue());
    }
    const expr = d.getCallExpression()?.getExpression() ?? d.getExpression();
    const decl = this.resolveDeclaration(expr);
    return decl ? pkgOf(decl.getSourceFile().getFilePath()) : '';
  }

  /** `'orders'`, `{ path: 'orders' }`, `['a', 'b']` (first) → the path segment; '' when absent. */
  private pathOf(arg: Node | undefined): string {
    if (!arg) return '';
    if (Node.isObjectLiteralExpression(arg)) {
      const p = arg.getProperty('path');
      return p && Node.isPropertyAssignment(p) ? this.pathOf(p.getInitializer()) : '';
    }
    if (Node.isArrayLiteralExpression(arg)) return this.pathOf(arg.getElements()[0]);
    const value = this.literal(arg);
    return value === '?' ? '' : value;
  }

  private globals(): Record<string, string> {
    if (!this.globalVars) {
      this.globalVars = {};
      for (const h of this.rules.hooks) Object.assign(this.globalVars, h.globalVars?.(this.hookContext()));
    }
    return this.globalVars;
  }

  private hookContext(): HookContext {
    return {
      literal: (n) => this.literal(n),
      callsNamed: (name) => this.callsNamed(name),
      resolve: (n) => this.resolveDeclaration(n),
      table: (of) => {
        const decl = of instanceof Node ? this.classOf(of) : of.getSymbol()?.getDeclarations()[0];
        return decl && Node.isClassDeclaration(decl) && this.isProjectFile(decl.getSourceFile().getFilePath()) ? entityTable(decl, (n) => this.literal(n)) : undefined;
      },
      decoratorFrom: (d) => this.decoratorPkg(d),
      projectFiles: () => this.projectFiles(),
      memo: <T>(key: string, compute: () => T): T => {
        if (!this.hookMemo.has(key)) this.hookMemo.set(key, compute());
        return this.hookMemo.get(key) as T;
      },
      isProjectCode: (n) => this.isProjectFile(n.getSourceFile().getFilePath()),
      collection: (receiver) => {
        const name = this.injectedName(receiver) ?? receiver.getType().getTypeArguments()[0]?.getSymbol()?.getName();
        return name ? collectionName(name) : undefined;
      },
    };
  }

  /** Calls whose callee is named `name`, project-wide (indexed once, by callee name). */
  private callsNamed(name: string): CallExpression[] {
    if (!this.callIndex) {
      this.callIndex = new Map();
      for (const file of this.projectFiles()) {
        for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const n = calleeName(call);
          if (!this.callIndex.has(n)) this.callIndex.set(n, []);
          this.callIndex.get(n)!.push(call);
        }
      }
    }
    return this.callIndex.get(name) ?? [];
  }

  /** Fills `{0}`, `{0.url}`, `{verb}`, `{a|b}` (first that exists) in an entry label. */
  private fill(template: string, args: Node[], vars: Record<string, string>): string {
    return template.replace(/\{([^}]+)\}/g, (_, spec: string) => {
      for (const alt of spec.split('|')) {
        if (/^\d+(\.\w+)?$/.test(alt)) {
          const node = argNode(args, alt);
          const value = node ? this.literal(node) : '?';
          if (value !== '?') return value;
        } else if (vars[alt] !== undefined && vars[alt] !== '?') {
          return vars[alt];
        }
      }
      return '?';
    });
  }

  // ---------- effects ----------

  computeTransitiveEffects(): void {
    const memo = new Map<string, Effect[]>();
    const visit = (opId: string, stack: Set<string>): Effect[] => {
      if (memo.has(opId)) return memo.get(opId)!;
      const op = this.snapshot.operations[opId];
      if (!op || stack.has(opId)) return [];
      stack.add(opId);
      const all = dedupeEffects([...op.directEffects, ...op.calls.flatMap((c) => visit(c, stack))]);
      stack.delete(opId);
      memo.set(opId, all);
      return all;
    };
    for (const op of Object.values(this.snapshot.operations)) op.effects = visit(op.id, new Set());
    for (const entry of Object.values(this.snapshot.entryPoints)) {
      const steps = this.snapshot.scopes[entry.id]?.steps ?? [];
      entry.effects = dedupeEffects(steps.flatMap((s) => (s.effect ? [s.effect] : s.target ? visit(s.target, new Set()) : [])));
    }
  }

  // ---------- helpers ----------

  private codeowners?: [RegExp, string][];

  /** Config `owners` globs first, then the repo's CODEOWNERS (read-only). Last matching pattern wins, like GitHub. */
  private ownerOf(file: string): string | undefined {
    const fromConfig = Object.entries(this.config.owners).filter(([glob]) => globToRegex(glob).test(file)).at(-1)?.[1];
    if (fromConfig) return fromConfig;
    if (!this.codeowners) {
      const where = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];
      // The repo's own (what GitHub reads); else one in the project folder (a package of a monorepo), whose patterns
      // are relative to that folder.
      let path = where.map((p) => join(this.repoRoot, p)).find(existsSync);
      let prefix = '';
      if (!path && this.rel(this.projectDir)) {
        path = where.map((p) => join(this.projectDir, p)).find(existsSync);
        prefix = `${this.rel(this.projectDir)}/`;
      }
      this.codeowners = (path ? readFileSync(path, 'utf8') : '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => {
          const [pattern, ...owners] = l.split(/\s+/);
          const anchored = pattern.startsWith('/') ? pattern.slice(1) : pattern.includes('/') ? pattern : `**/${pattern}`;
          return [globToRegex(`${prefix}${anchored.endsWith('/') ? `${anchored}**` : anchored}`), owners.join(' ')] as [RegExp, string];
        });
    }
    return this.codeowners.filter(([re]) => re.test(file)).at(-1)?.[1];
  }

  /** Constant value of an expression (string, number, enum member, string array, `Class.name`), else `<text>`. */
  private literal(arg: Node | undefined): string {
    if (!arg) return '?';
    if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) return arg.getLiteralValue();
    if (Node.isNumericLiteral(arg)) return String(arg.getLiteralValue());
    if (Node.isArrayLiteralExpression(arg) && arg.getElements().length) {
      const items = arg.getElements().map((e) => this.literal(e));
      if (items.every((i) => !i.startsWith('<'))) return items.join(', ');
    }
    if (Node.isPropertyAccessExpression(arg) && arg.getName() === 'name') {
      const cls = this.classOf(arg.getExpression());
      if (cls?.getName()) return cls.getName()!;
    }
    const type = arg.getType();
    if (type.isStringLiteral() || type.isNumberLiteral()) return String(type.getLiteralValue());
    return `<${short(arg.getText(), 30)}>`;
  }

  private params(fn: Fn): Param[] {
    return fn.getParameters().map((p) => {
      const param: Param = { name: p.getName(), type: typeText(p.getType(), fn) };
      // A documented input type (a DTO with `@ApiProperty({ description })` or field doc comments): one level of its fields.
      const cls = p.getType().getNonNullableType().getSymbol()?.getDeclarations()[0];
      if (cls && Node.isClassDeclaration(cls) && this.isProjectFile(cls.getSourceFile().getFilePath())) {
        const fields = cls.getProperties().filter((f) => !f.isStatic()).slice(0, 16).map((f) => ({ name: f.getName(), type: typeText(f.getType(), fn), description: this.fieldDoc(f) }));
        if (fields.some((f) => f.description)) param.fields = fields.map((f) => (f.description ? f : { name: f.name, type: f.type }));
      }
      return param;
    });
  }

  private shape(type: Type, at: Node): TypeShape {
    const t = type.getNonNullableType();
    const shape: TypeShape = { type: typeText(type, at) };
    if (t.isObject() && !t.isArray() && t.getCallSignatures().length === 0 && !t.isUnion()) {
      shape.fields = t.getProperties().slice(0, 16).map((p) => {
        const description = this.fieldDoc(p.getDeclarations()[0]);
        return { name: p.getName(), type: typeText(p.getTypeAtLocation(at), at), ...(description ? { description } : {}) };
      });
    }
    return shape;
  }

  private generated = new Map<string, boolean>();

  /** Code of the service itself: not a dependency, not a declaration file, not generated (Prisma client, protobuf stubs). */
  private isProjectFile(path: string): boolean {
    if (path.includes('/node_modules/') || path.endsWith('.d.ts') || relative(this.projectDir, path).startsWith('..')) return false;
    if (!this.generated.has(path)) {
      const head = this.project.getSourceFile(path)?.getFullText().slice(0, 400) ?? '';
      this.generated.set(path, /@generated|code generated by|do not edit/i.test(head));
    }
    return !this.generated.get(path);
  }

  private rel(path: string): string {
    return relative(this.repoRoot, path).replace(/\\/g, '/');
  }
}

// ---------- pure helpers ----------

/** Something that runs before a scope's own function: a pipeline item (`label`), or an earlier start hook (`cls`). */
interface Prelude {
  fn: Fn;
  name: string;
  /** Index in the entry point's pipeline; -1 for an earlier start hook. */
  item: number;
  label?: string;
  cls?: ClassDeclaration;
}

/** Where a start method runs among the others: framework start hooks in their order, then the rule's order. */
function startRank(name: string, listed: string[]): number {
  const i = START_ORDER.indexOf(name);
  return i >= 0 ? i : START_ORDER.length + Math.max(0, listed.indexOf(name));
}

function methodsOf(rule: CallMatch): string[] {
  return Array.isArray(rule.method) ? rule.method : rule.method.split('|');
}

function matches(rule: CallMatch, site: CallSite): boolean {
  const classOk = (c: string | undefined) => rule.class === undefined || (c !== undefined && rule.class.split('|').includes(c));
  const moduleOk = (m: string | undefined) => rule.module === undefined || (m !== undefined && rule.module.split('|').includes(m));
  // The declaring class (and its package), or the receiver's own class (a subclass that inherits the method).
  return methodsOf(rule).includes(site.name) && ((classOk(site.owner) && moduleOk(site.pkg)) || (site.receiverClass !== undefined && classOk(site.receiverClass) && moduleOk(site.receiverPkg)));
}

/** `x.y.method(…)` → "method"; `fn(…)` → "fn"; `new Worker(…)` → "Worker". */
function calleeName(call: Invocation): string {
  const expr = call.getExpression();
  if (Node.isPropertyAccessExpression(expr)) return expr.getName();
  if (Node.isIdentifier(expr)) return expr.getText();
  return '';
}

function lastName(node: Node): string {
  if (Node.isPropertyAccessExpression(node)) return node.getName();
  if (Node.isCallExpression(node)) return lastName(node.getExpression());
  return short(node.getText(), 20);
}

/**
 * `config.get('TOPICS').ORDER_CREATED`, `this.configService.get<T>('kafka.topics.created')`: the config key
 * (`TOPICS.ORDER_CREATED`). A `get` on something called `config…`, with a constant key.
 */
function configKey(node: Node, literal: (n: Node) => string): string | undefined {
  const path: string[] = [];
  let cur = node;
  for (;;) {
    if (Node.isNonNullExpression(cur) || Node.isParenthesizedExpression(cur)) cur = cur.getExpression();
    else if (Node.isPropertyAccessExpression(cur)) {
      path.unshift(cur.getName());
      cur = cur.getExpression();
    } else if (Node.isElementAccessExpression(cur)) {
      const k = literal(cur.getArgumentExpressionOrThrow());
      if (k.startsWith('<') || k === '?') return undefined;
      path.unshift(k);
      cur = cur.getExpression();
    } else break;
  }
  if (!Node.isCallExpression(cur)) return undefined;
  const callee = cur.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || !/^(get|getOrThrow)$/.test(callee.getName()) || !/config/i.test(callee.getExpression().getText())) return undefined;
  const first = cur.getArguments()[0];
  const key = first ? literal(first) : '?';
  if (key.startsWith('<') || key === '?') return undefined;
  return [key, ...path].join('.');
}

/** `0` → args[0]; `0.topic` → the `topic` property of an object literal args[0] (or of the variable it names). */
function argNode(args: Node[], spec: string): Node | undefined {
  const [index, prop] = spec.split('.');
  let node: Node | undefined = args[Number(index)];
  if (!node || !prop) return node;
  if (Node.isIdentifier(node)) {
    const decl = node.getSymbol()?.getDeclarations()[0];
    if (decl && Node.isVariableDeclaration(decl)) node = decl.getInitializer();
  }
  if (!node || !Node.isObjectLiteralExpression(node)) return undefined;
  const p = node.getProperty(prop);
  if (!p) return undefined;
  if (Node.isPropertyAssignment(p)) return p.getInitializer();
  if (Node.isShorthandPropertyAssignment(p)) return p.getNameNode();
  return p;
}

/** npm package a declaration comes from; 'global' for built-ins (lib.d.ts, @types/node); '' for project code. */
export function pkgOf(path: string): string {
  const p = path.replace(/\\/g, '/');
  const i = p.lastIndexOf('/node_modules/');
  if (i < 0) return '';
  const rest = p.slice(i + '/node_modules/'.length).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  if (name === 'typescript' || name === '@types/node' || name === 'undici-types') return 'global';
  // Types published apart (`@types/ssh2-sftp-client`, `@types/scope__pkg`) describe the package itself.
  if (name.startsWith('@types/')) {
    const real = name.slice(7);
    return real.includes('__') ? `@${real.replace('__', '/')}` : real;
  }
  return name;
}

function packageRoot(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** '/' + non-empty segments of every part: joinPath('api', 'orders', ':id') = '/api/orders/:id'. */
export function joinPath(...parts: (string | undefined)[]): string {
  return `/${parts.flatMap((p) => (p ?? '').split('/')).filter(Boolean).join('/')}`;
}

/** TypeORM table: `@Entity('orders')` / `@Entity({ name })`, else the class name in snake_case. */
function entityTable(cls: ClassDeclaration, literal: (n: Node) => string): string {
  const dec = cls.getDecorator('Entity') ?? cls.getDecorator('ViewEntity');
  const arg = dec?.getArguments()[0];
  if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) return arg.getLiteralValue();
  if (arg && Node.isObjectLiteralExpression(arg)) {
    const p = arg.getProperty('name');
    if (p && Node.isPropertyAssignment(p)) return literal(p.getInitializer()!);
  }
  return (cls.getName() ?? 'entity').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Mongoose's default collection: lower-case, plural model name (`Order` → `orders`). */
export function collectionName(model: string): string {
  const base = model.replace(/(Document|Doc|Schema|Model)$/, '') || model;
  const lower = base.charAt(0).toLowerCase() + base.slice(1);
  const snake = lower.toLowerCase();
  return /s$/.test(snake) ? snake : /y$/.test(snake) ? `${snake.slice(0, -1)}ies` : `${snake}s`;
}

function guardOf(call: Node, fn: Node): { condition?: string; loop?: boolean; guardNodes: Node[] } {
  const conditions: string[] = [];
  const guardNodes: Node[] = [];
  let loop = false;
  let child: Node = call;
  let node = call.getParent();
  while (node && node !== fn) {
    if (Node.isIfStatement(node)) {
      const cond = short(node.getExpression().getText(), 40);
      if (child === node.getThenStatement()) conditions.push(`if (${cond})`);
      else if (child === node.getElseStatement()) conditions.push(unless(cond));
      if (child !== node.getExpression()) guardNodes.push(node.getExpression());
    } else if (Node.isConditionalExpression(node)) {
      if (child !== node.getCondition()) guardNodes.push(node.getCondition());
      const cond = short(node.getCondition().getText(), 40);
      if (child === node.getWhenTrue()) conditions.push(`if (${cond})`);
      else if (child === node.getWhenFalse()) conditions.push(unless(cond));
    } else if (Node.isBinaryExpression(node) && child === node.getRight()) {
      const op = node.getOperatorToken().getKind();
      const left = short(node.getLeft().getText(), 40);
      if (op === SyntaxKind.QuestionQuestionToken) conditions.push(`if ${left} is missing`);
      else if (op === SyntaxKind.BarBarToken) conditions.push(unless(left));
      else if (op === SyntaxKind.AmpersandAmpersandToken) conditions.push(`if (${left})`);
    } else if (
      Node.isForOfStatement(node) || Node.isForInStatement(node) || Node.isForStatement(node) ||
      Node.isWhileStatement(node) || Node.isDoStatement(node)
    ) {
      if (child === node.getStatement()) loop = true;
    } else if (Node.isCallExpression(node) && isFnNode(child) && /\.(map|forEach|flatMap|filter|reduce|some|every)$/.test(node.getExpression().getText())) {
      loop = true;
    } else if (Node.isCatchClause(node)) {
      conditions.push('on error');
    } else if (Node.isBlock(node)) {
      // Early-return guards: `if (x) return ...;` before this statement means we only get here unless x.
      for (const stmt of node.getStatements()) {
        if (stmt === child) break;
        if (Node.isIfStatement(stmt) && !stmt.getElseStatement() && exits(stmt.getThenStatement())) {
          conditions.push(unless(short(stmt.getExpression().getText(), 40)));
          guardNodes.push(stmt.getExpression());
        }
      }
    }
    child = node;
    node = node.getParent();
  }
  return { condition: conditions.reverse().join(' and ') || undefined, loop: loop || undefined, guardNodes };
}

/** `unless (x)`, but `if (x)` for `unless (!x)`: an early `if (!order) throw` means "only when order". */
function unless(cond: string): string {
  const m = /^!([\w$.]+|\([^()]*\))$/.exec(cond);
  return m ? `if (${m[1].replace(/^\((.*)\)$/, '$1')})` : `unless (${cond})`;
}

/** The call expression a reference names: `x.method(…)` or `fn(…)`. */
function callOf(ref: Node): CallExpression | undefined {
  const parent = ref.getParent();
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === ref) {
    const call = parent.getParent();
    return Node.isCallExpression(call) && call.getExpression() === parent ? call : undefined;
  }
  return Node.isCallExpression(parent) && parent.getExpression() === ref ? parent : undefined;
}

function isAnonymous(fn: Node): boolean {
  return Node.isArrowFunction(fn) || Node.isFunctionExpression(fn);
}

function isTypeDecl(n: Node): boolean {
  return Node.isInterfaceDeclaration(n) || Node.isTypeAliasDeclaration(n) || Node.isEnumDeclaration(n);
}

/**
 * The scope's own early exits, `if (!check.ok) throw new X('…')` or `if (!user) return null`, that come before at
 * least one step: the other side of the guard the later steps run under.
 */
function exitsOf(fn: Fn, file: string, steps: Step[]): Exit[] {
  const body = fn.getBody();
  if (!body) return [];
  const lastStep = Math.max(0, ...steps.map((s) => s.line));
  const out: Exit[] = [];
  for (const stmt of body.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    if (stmt.getFirstAncestor(isFnNode) !== fn || stmt.getElseStatement() || !exits(stmt.getThenStatement())) continue;
    if (!Node.isBlock(stmt.getParent()) || stmt.getEndLineNumber() >= lastStep) continue;
    const then = stmt.getThenStatement();
    const last = Node.isBlock(then) ? then.getStatements().at(-1)! : then;
    const exit: Exit = { guard: unless(short(stmt.getExpression().getText(), 40)), kind: Node.isThrowStatement(last) ? 'throw' : 'return', line: last.getStartLineNumber(), file };
    const expr = Node.isThrowStatement(last) || Node.isReturnStatement(last) ? last.getExpression() : undefined;
    if (expr && Node.isNewExpression(expr)) {
      exit.what = expr.getExpression().getText();
      const arg = expr.getArguments()[0];
      const msg = arg && Node.isStringLiteral(arg) ? arg : arg && Node.isObjectLiteralExpression(arg) ? arg.getProperty('message')?.getLastChild() : undefined;
      if (msg && (Node.isStringLiteral(msg) || Node.isNoSubstitutionTemplateLiteral(msg))) exit.message = msg.getLiteralText();
    } else if (expr) exit.what = short(expr.getText(), 40);
    out.push(exit);
  }
  return out;
}

function exits(stmt: Node): boolean {
  if (Node.isReturnStatement(stmt) || Node.isThrowStatement(stmt)) return true;
  if (Node.isBlock(stmt)) {
    const last = stmt.getStatements().at(-1);
    return !!last && (Node.isReturnStatement(last) || Node.isThrowStatement(last));
  }
  return false;
}

/** The description of a doc comment (`/** … *\/`), on one line; '' when there is none. */
function jsDocOf(node: Node): string {
  const docs = 'getJsDocs' in node ? (node as unknown as { getJsDocs(): { getDescription(): string }[] }).getJsDocs() : [];
  return squashText(docs.map((d) => d.getDescription().trim()).join(' '));
}

function squashText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Tests and their helpers: `*.spec.ts`, `*.test.ts`, `*.e2e-spec.ts`, anything under `test/`, `__tests__/`, `e2e/`. */
export function isTestFile(relPath: string): boolean {
  return /\.(spec|test|e2e-spec|e2e)\.[cm]?[jt]sx?$/.test(relPath) || /(^|\/)(__tests__|__mocks__|tests?|e2e)\//.test(relPath);
}

/** Developer tooling next to the service: dot-folders (`.dev/`, `.github/`) and a top-level `scripts/` or `tools/`. */
export function isDevFile(relPath: string): boolean {
  return /(^|\/)\.[^/]+\//.test(relPath) || /^(scripts|tools)\//.test(relPath);
}

function isFnNode(n: Node): n is Fn {
  return Node.isMethodDeclaration(n) || Node.isFunctionDeclaration(n) || Node.isArrowFunction(n) || Node.isFunctionExpression(n);
}

const isFn = isFnNode;

function rank(n: Node): number {
  return Node.isCallExpression(n) || Node.isNewExpression(n) ? 0 : 1;
}

function unwrap(node: Node): Node {
  while (
    Node.isAwaitExpression(node) || Node.isParenthesizedExpression(node) || Node.isAsExpression(node) ||
    Node.isNonNullExpression(node) || Node.isSatisfiesExpression(node)
  ) {
    node = node.getExpression();
  }
  return node;
}

function isPromiseAll(node: Node): boolean {
  return Node.isCallExpression(node) && /^Promise\.(all|allSettled)$/.test(node.getExpression().getText());
}

function rootIdentifier(node: Node): string | undefined {
  let cur = node;
  while (Node.isPropertyAccessExpression(cur) || Node.isElementAccessExpression(cur)) cur = cur.getExpression();
  return Node.isIdentifier(cur) ? cur.getText() : undefined;
}

function bindingNames(node: Node): string[] {
  if (Node.isIdentifier(node)) return [node.getText()];
  return node.getDescendantsOfKind(SyntaxKind.BindingElement).flatMap((el) => {
    const name = el.getNameNode();
    return Node.isIdentifier(name) ? [name.getText()] : [];
  });
}

function relabel(prod: Prod | undefined, label: string): Prod {
  const out: Prod = new Map();
  for (const key of prod?.keys() ?? []) out.set(key, new Set([label]));
  return out;
}

function strip(prod: Prod): Prod {
  return new Map([...prod.keys()].map((k) => [k, new Set<string>()]));
}

function mergeInto(target: Prod, source: Prod): void {
  for (const [k, labels] of source) {
    const set = target.get(k) ?? new Set<string>();
    labels.forEach((l) => set.add(l));
    target.set(k, set);
  }
}

function mergeEdges(edges: Edge[]): Edge[] {
  const byKey = new Map<string, Edge>();
  for (const e of edges) {
    const key = `${e.from}->${e.to}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...e });
      continue;
    }
    if (e.kind === 'data') prev.kind = 'data';
    const labels = new Set([...(prev.label?.split(', ') ?? []), ...(e.label?.split(', ') ?? [])].filter(Boolean));
    prev.label = [...labels].join(', ') || undefined;
  }
  return [...byKey.values()];
}

function unwrapPromise(type: Type): Type {
  return type.getSymbol()?.getName() === 'Promise' ? type.getTypeArguments()[0] ?? type : type;
}

function typeText(type: Type, at: Node): string {
  // `import("C:/…/user-record-status.enum").X` → `X`: no machine's folder names in a review (enum members included).
  const unqualified = (t: string) => t.replace(/import\("[^"]+"\)\./g, '');
  let text = unqualified(type.getText(at, TypeFormatFlags.UseAliasDefinedOutsideCurrentScope));
  // `status: KycStatus` hides which values exist; adding one is a contract change callers must handle.
  const members = type.getNonNullableType().isUnion() ? type.getNonNullableType().getUnionTypes() : [];
  if (members.length > 1 && members.length <= 12 && members.every((m) => m.isLiteral()) && !text.includes('"')) {
    text += ` [${members.map((m) => unqualified(m.getText(at, TypeFormatFlags.UseAliasDefinedOutsideCurrentScope))).join(' | ')}]`;
  }
  return short(text, MAX_TYPE + 60);
}

function short(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function dedent(text: string): string {
  const lines = text.split(/\r?\n/);
  const indent = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
  return [lines[0], ...lines.slice(1).map((l) => l.slice(Number.isFinite(indent) ? indent : 0))].join('\n');
}

function globToRegex(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(.*/)?')
    .replace(/\u0002/g, '.*');
  return new RegExp(`^${re}(/.*)?$`);
}

/** A package is installed when node_modules/<pkg> exists in the project folder or above it. */
function installed(projectDir: string, pkg: string): boolean {
  for (let dir = projectDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', pkg))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** `OrdersService.cancel`, `bootstrap`, `handler` (an arrow in a variable). */
function fnName(fn: Node): string {
  if (Node.isMethodDeclaration(fn)) {
    const cls = fn.getParent();
    return `${Node.isClassDeclaration(cls) ? `${cls.getName() ?? 'class'}.` : ''}${fn.getName()}`;
  }
  if (Node.isFunctionDeclaration(fn)) return fn.getName() ?? 'function';
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
  const outer = fn.getFirstAncestor(isFnNode);
  return outer ? `callback in ${fnName(outer)}` : 'anonymous function';
}

/** A name imported into `file` is used as a value somewhere (not only in types; a constructor parameter's type is injected, so it counts). */
function usedAsValue(file: SourceFile, name: string): boolean {
  return file.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => id.getText() === name && !id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) && !inTypePosition(id));
}

function inTypePosition(id: Node): boolean {
  let top: Node | undefined;
  for (let cur = id.getParent(); cur; cur = cur.getParent()) {
    if (Node.isHeritageClause(cur)) return cur.getToken() === SyntaxKind.ImplementsKeyword;
    if (Node.isTypeNode(cur) && !Node.isExpressionWithTypeArguments(cur)) top = cur;
    else if (top) break;
  }
  if (!top) return Node.isTypeAliasDeclaration(id.getParent()) || Node.isInterfaceDeclaration(id.getParent());
  const holder = top.getParent();
  return !(holder && Node.isParameterDeclaration(holder) && Node.isConstructorDeclaration(holder.getParent()));
}

/** `cls` extends `base`, directly or further up. */
function isSubclassOf(cls: ClassDeclaration, base: ClassDeclaration): boolean {
  for (let cur: ClassDeclaration | undefined = cls.getBaseClass(), depth = 0; cur && depth < 8; cur = cur.getBaseClass(), depth++) if (cur === base) return true;
  return false;
}

/** The class extends a class with this name, directly or further up (a base class from a package counts). */
function extendsNamed(cls: ClassDeclaration, name: string): boolean {
  let cur: ClassDeclaration | undefined = cls;
  for (let depth = 0; cur && depth < 8; depth++) {
    if (cur.getExtends()?.getExpression().getText() === name) return true;
    cur = cur.getBaseClass();
  }
  return false;
}

/** The command-line argument a bootstrap call runs under: `case 'x':` or `if (arg === 'x')` around it. */
function commandAround(call: Node, literal: (n: Node) => string): string | undefined {
  for (let cur = call.getParent(); cur; cur = cur.getParent()) {
    if (Node.isCaseClause(cur)) {
      const v = literal(cur.getExpression());
      if (!v.startsWith('<') && v !== '?') return v;
    }
    if (Node.isIfStatement(cur)) {
      const cond = cur.getExpression();
      if (Node.isBinaryExpression(cond) && /^===?$/.test(cond.getOperatorToken().getText())) {
        for (const side of [cond.getLeft(), cond.getRight()]) {
          if (Node.isStringLiteral(side)) return side.getLiteralValue();
        }
      }
    }
  }
  return undefined;
}

/** A method of a class or one of its base classes. */
function methodOf(cls: ClassDeclaration, name: string): MethodDeclaration | undefined {
  for (let c: ClassDeclaration | undefined = cls, depth = 0; c && depth < 8; c = c.getBaseClass(), depth++) {
    const m = c.getMethod(name);
    if (m && !m.isAbstract()) return m;
  }
  return undefined;
}
