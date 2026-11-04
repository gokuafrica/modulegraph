import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
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
  type Type,
} from 'ts-morph';
import type { Edge, Effect, EntryPoint, Param, Scope, Step, TypeShape } from '../../../../schema/modulegraph.ts';
import type { CallMatch, Config, DecoratorEntryRule, EntryRule, ResponseRule, SinkRule } from '../../config.ts';
import { dedupeEffects } from '../../effects.ts';
import type { OperationTarget, Part, RevisionAnalysis, Snapshot } from '../types.ts';
import type { CallSite, Framework, FrameworkHooks, HookContext } from './frameworks/types.ts';

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
  | { kind: 'unknown' };

interface FnResult {
  steps: Step[];
  edges: Edge[];
  returns: Prod;
  parts: Part[];
  /** Arguments of response calls (`res.json(x)`): what the handler returns when it doesn't `return`. */
  responses: Node[];
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
  /** Callee names that can register an entry point (cheap filter before type resolution). */
  entryNames: Set<string>;
}

const MAX_TYPE = 110;

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

  constructor(
    private project: Project,
    private repoRoot: string,
    private projectDir: string,
    private config: Config,
    frameworks: Framework[] = [],
  ) {
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
      entryNames: new Set(entries.flatMap((r) => (methodsOf(r).includes('new') ? (r.class ?? '').split('|') : methodsOf(r)))),
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
    for (const cls of this.discoverModules(this.projectFiles().flatMap((f) => f.getClasses()))) this.registerModule(cls);
  }

  private projectFiles() {
    return this.project.getSourceFiles().filter((f) => this.isProjectFile(f.getFilePath()));
  }

  // ---------- lazy API ----------

  /** Public methods of all modules: the operations that exist, analyzed or not. */
  knownOperations(): string[] {
    return [...this.moduleIds.keys()].flatMap((cls) => this.publicMethods(cls).map((m) => `${cls.getName()}.${m.getName()}`));
  }

  /** Class, file and parameter names of every module method: what the example recorder wraps. */
  operationTargets(): OperationTarget[] {
    return [...this.moduleIds.keys()].flatMap((cls) =>
      this.publicMethods(cls).map((m) => ({
        opId: `${cls.getName()}.${m.getName()}`,
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
    for (const file of this.projectFiles()) {
      for (const node of file.getDescendants()) {
        if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
          if (this.rules.entryNames.has(calleeName(node))) this.entryIdOf(node);
        } else if (Node.isMethodDeclaration(node) && this.rules.decorators.length) {
          this.decoratorEntryOf(node);
        }
      }
    }
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
      if (!call) continue;
      // Calls from the same class are inlined into the caller, not a step: same rule as `resolve`.
      for (const id of this.scopesAt(call)) if (!id.startsWith(`${found.cls.getName()}.`)) out.add(id);
    }
    return [...out];
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
    return this.scopesAt(node);
  }

  /**
   * Scopes whose steps would include something located at `node`: the entry handler or operation around it,
   * and, for helpers that get inlined, everything that calls the helper.
   */
  scopesAt(node: Node, seen = new Set<Node>()): string[] {
    for (let cur = node.getParent(); cur; cur = cur.getParent()) {
      if (Node.isCallExpression(cur) || Node.isNewExpression(cur)) {
        const id = this.entryIdOf(cur);
        if (id) return [id];
      }
      if (Node.isMethodDeclaration(cur)) {
        const id = this.decoratorEntryOf(cur);
        if (id) return [id];
      }
      if (isFnNode(cur) && !isAnonymous(cur)) break;
    }
    let fn: Node | undefined = isFnNode(node) ? node : node.getFirstAncestor(isFnNode);
    while (fn && isAnonymous(fn) && !Node.isVariableDeclaration(fn.getParent())) fn = fn.getFirstAncestor(isFnNode);
    if (!fn || seen.has(fn)) return [];
    seen.add(fn);
    const out: string[] = [];
    if (Node.isMethodDeclaration(fn)) {
      const entry = this.decoratorEntryOf(fn);
      if (entry) return [entry];
      const cls = fn.getParent();
      if (Node.isClassDeclaration(cls) && this.moduleIds.has(cls) && this.isOperation(fn)) {
        out.push(`${cls.getName()}.${fn.getName()}`);
        // Public methods of the same class that call this one inline it.
        for (const ref of fn.findReferencesAsNodes()) {
          const call = callOf(ref);
          if (call && call.getFirstAncestor((n) => Node.isClassDeclaration(n)) === cls) out.push(...this.scopesAt(call, seen));
        }
        return out;
      }
    }
    // A helper (private method, function, arrow in a variable): inlined wherever it is called.
    const named = Node.isVariableDeclaration(fn.getParent()) ? fn.getParent()! : fn;
    const refs = 'findReferencesAsNodes' in named ? (named as unknown as { findReferencesAsNodes(): Node[] }).findReferencesAsNodes() : [];
    for (const ref of refs) out.push(...this.scopesAt(ref, seen));
    return [...new Set(out)];
  }

  private entryIdOf(call: Invocation): string | undefined {
    if (!this.entryIdCache.has(call)) this.entryIdCache.set(call, this.rules.entryNames.has(calleeName(call)) ? this.entryStub(call) : undefined);
    return this.entryIdCache.get(call);
  }

  private findOp(opId: string): { cls: ClassDeclaration; method: MethodDeclaration } | undefined {
    const dot = opId.indexOf('.');
    const className = opId.slice(0, dot);
    const name = opId.slice(dot + 1);
    const cls = [...this.moduleIds.keys()].find((c) => c.getName() === className);
    const method = cls && this.publicMethods(cls).find((m) => m.getName() === name);
    return cls && method ? { cls, method } : undefined;
  }

  private publicMethods(cls: ClassDeclaration): MethodDeclaration[] {
    return cls.getMethods().filter((m) => this.isOperation(m));
  }

  private isOperation(m: MethodDeclaration): boolean {
    return m.getScope() === MemberScope.Public && !m.getName().startsWith('#') && !m.isStatic() && !this.rules.ignoreMethods.has(m.getName());
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
      const decorators = cls.getDecorators().map((d) => d.getName());
      if (decorators.some((d) => this.rules.notModuleDecorators.has(d))) return false;
      if (cls.getImplements().some((i) => this.rules.notModuleImplements.has(i.getExpression().getText()))) return false;
      if (this.rules.decorators.length && cls.getMethods().some((m) => this.decoratorEntryOf(m))) return false;
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
      name: override.name ?? (named ? named[1] : className.replace(/(Module|Service)$/, '') || className),
      className,
      file,
      line: cls.getStartLineNumber(),
      summary: (override.summary ?? (named ? named[2] : description)).replace(/\s+/g, ' '),
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
    const id = `${cls.getName()}.${method.getName()}`;
    if (this.snapshot.operations[id]) return;
    this.currentClass = cls;
    const scope = this.buildScope(id, method);
    this.currentClass = undefined;
    const steps = scope.result.steps;
    if (!this.snapshot.modules[moduleId].operations.includes(id)) this.snapshot.modules[moduleId].operations.push(id);
    this.snapshot.operations[id] = {
      id,
      moduleId,
      name: method.getName(),
      file: this.rel(method.getSourceFile().getFilePath()),
      line: method.getStartLineNumber(),
      endLine: method.getEndLineNumber(),
      params: this.params(method),
      returns: this.shape(unwrapPromise(method.getReturnType()), method),
      directEffects: dedupeEffects(steps.filter((s) => s.effect).map((s) => s.effect!)),
      effects: [],
      calls: [...new Set(steps.filter((s) => s.target).map((s) => s.target!))],
      change: 'unchanged',
      containsChanges: false,
      source: dedent(method.getText()),
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
    return this.addEntry(`${rule.kind}:${label}`, rule.kind, label, rule.readOnly, { at: call, handler });
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
        const label = this.fill(rule.label, args, vars);
        id = this.addEntry(`${rule.kind}:${label}`, rule.kind, label, rule.readOnly, { at: method, handler: method });
        break;
      }
    }
    this.entryIdCache.set(method, id);
    return id;
  }

  private addEntry(id: string, kind: EntryPoint['kind'], label: string, readOnly: boolean | undefined, site: EntrySite): string {
    if (this.entrySites.has(id)) return id;
    this.entrySites.set(id, site);
    this.snapshot.entryPoints[id] = {
      id,
      kind,
      label,
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
    const { at, handler } = this.entrySites.get(id)!;
    const scope = this.buildScope(id, handler);
    const label = this.snapshot.entryPoints[id].label;
    this.recordParts(id, { name: label, role: 'handler', file: this.rel(at.getSourceFile().getFilePath()), line: at.getStartLineNumber(), text: at.getText() }, scope.result.parts);
  }

  private recordParts(id: string, own: Part, inlined: Part[]): void {
    const seen = new Set<string>();
    const parts = [own, ...inlined].filter((p) => !seen.has(p.name) && !!seen.add(p.name));
    this.snapshot.parts[id] = parts.map((p) => ({ ...p, text: dedent(p.text) }));
    this.snapshot.fingerprints[id] = normalise([own.text, ...inlined.map((p) => p.text)].join('\n'));
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

  private buildScope(id: string, fn: Fn): { scope: Scope; result: FnResult } {
    this.stepCounter = 0;
    const result = this.analyzeFn(fn, new Set([fn]));
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
    this.snapshot.scopes[id] = scope;
    return { scope, result };
  }

  private analyzeFn(fn: Fn, stack: Set<Node>): FnResult {
    const steps: Step[] = [];
    const edges: Edge[] = [];
    const parts: Part[] = [];
    const responses: Node[] = [];
    const vars = new Map<string, Prod>();
    const callProd = new Map<Node, Prod>();
    let returns: Prod = new Map();
    for (const p of fn.getParameters()) {
      for (const name of bindingNames(p.getNameNode())) vars.set(name, new Map([['entry', new Set()]]));
    }
    const body = fn.getBody();
    if (!body) return { steps, edges, returns, parts, responses };

    const prodOf = (node: Node | undefined): Prod => {
      if (!node) return new Map();
      node = unwrap(node);
      if (callProd.has(node)) return callProd.get(node)!;
      if (Node.isIdentifier(node)) return relabel(vars.get(node.getText()), node.getText());
      if (Node.isShorthandPropertyAssignment(node)) return relabel(vars.get(node.getName()), node.getName());
      if (Node.isPropertyAssignment(node)) return prodOf(node.getInitializer());
      if (Node.isPropertyAccessExpression(node)) {
        const root = rootIdentifier(node);
        if (root && vars.get(root)?.has('entry')) return new Map([['entry', new Set([short(node.getText(), 40)])]]);
        return prodOf(node.getExpression());
      }
      const out: Prod = new Map();
      node.forEachChild((child) => mergeInto(out, prodOf(child)));
      return out;
    };

    const bind = (nameNode: Node, init: Node | undefined) => {
      if (!init) return;
      const value = unwrap(init);
      if (Node.isArrayBindingPattern(nameNode) && isPromiseAll(value)) {
        const items = (value as CallExpression).getArguments()[0];
        if (Node.isArrayLiteralExpression(items)) {
          nameNode.getElements().forEach((el, i) => {
            if (Node.isBindingElement(el)) bind(el.getNameNode(), items.getElements()[i]);
          });
          return;
        }
      }
      const produced = strip(prodOf(init));
      for (const name of bindingNames(nameNode)) vars.set(name, produced);
    };

    const handleCall = (call: Invocation) => {
      const resolved = this.resolve(call);
      if (resolved.kind === 'response') {
        if (resolved.arg) {
          mergeInto(returns, prodOf(resolved.arg));
          responses.push(resolved.arg);
        }
        return;
      }
      const { guardNodes, ...guard } = guardOf(call, fn);
      const guards: Prod = new Map();
      for (const g of guardNodes) mergeInto(guards, strip(prodOf(g)));
      const inputs = new Map<string, Set<string>>();
      for (const arg of call.getArguments()) mergeInto(inputs, prodOf(arg));
      if (resolved.kind === 'op' || resolved.kind === 'sink') {
        const step: Step = {
          id: `s${++this.stepCounter}`,
          kind: resolved.kind === 'op' ? 'call' : 'effect',
          ...(resolved.kind === 'op' ? { target: resolved.opId } : { effect: resolved.effect }),
          line: call.getStartLineNumber(),
          file: this.rel(call.getSourceFile().getFilePath()),
          ...guard,
        };
        steps.push(step);
        for (const [producer, labels] of inputs) {
          edges.push({ from: producer, to: step.id, kind: 'data', label: [...labels].join(', ') || undefined });
        }
        for (const producer of guards.keys()) {
          if (producer !== 'entry' && !inputs.has(producer)) edges.push({ from: producer, to: step.id, kind: 'control', label: 'guards' });
        }
        callProd.set(call, new Map([[step.id, new Set()]]));
      } else if (resolved.kind === 'inline' && !stack.has(resolved.fn)) {
        stack.add(resolved.fn);
        const sub = this.analyzeFn(resolved.fn, stack);
        stack.delete(resolved.fn);
        parts.push({ name: resolved.name, role: 'helper', file: this.rel(resolved.fn.getSourceFile().getFilePath()), line: resolved.fn.getStartLineNumber(), text: resolved.fn.getText() }, ...sub.parts);
        for (const s of sub.steps) {
          steps.push({
            ...s,
            condition: [guard.condition, s.condition].filter(Boolean).join(' and ') || undefined,
            loop: guard.loop || s.loop || undefined,
            via: s.via ?? resolved.name,
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
        callProd.set(call, result);
        responses.push(...sub.responses);
      }
    };

    const nodes = [body, ...body.getDescendants()];
    const events = nodes.filter(
      (n) =>
        Node.isCallExpression(n) ||
        Node.isNewExpression(n) && this.rules.sinks.some((r) => methodsOf(r).includes('new')) ||
        Node.isVariableDeclaration(n) ||
        Node.isBinaryExpression(n) && n.getOperatorToken().getKind() === SyntaxKind.EqualsToken ||
        Node.isReturnStatement(n) && n.getFirstAncestor(isFnNode) === fn,
    );
    events.sort((a, b) => a.getEnd() - b.getEnd() || rank(a) - rank(b));
    for (const ev of events) {
      if (Node.isCallExpression(ev) || Node.isNewExpression(ev)) handleCall(ev);
      else if (Node.isVariableDeclaration(ev)) {
        const loop = ev.getParent()?.getParent();
        bind(ev.getNameNode(), Node.isForOfStatement(loop) || Node.isForInStatement(loop) ? loop.getExpression() : ev.getInitializer());
      }
      else if (Node.isBinaryExpression(ev)) bind(ev.getLeft(), ev.getRight());
      else if (Node.isReturnStatement(ev)) mergeInto(returns, prodOf(ev.getExpression()));
    }
    if (!Node.isBlock(body)) returns = prodOf(body);
    return { steps, edges, returns, parts, responses };
  }

  // ---------- resolution ----------

  private resolve(call: Invocation): Resolved {
    const site = this.site(call);
    if (site && (site.owner || site.pkg)) {
      const effect = this.sinkEffect(site);
      if (effect) return { kind: 'sink', effect: { ...effect, file: this.rel(call.getSourceFile().getFilePath()), line: call.getStartLineNumber() } };
      const response = this.rules.responses.find((r) => matches(r, site));
      if (response) return { kind: 'response', arg: call.getArguments()[response.arg] };
    }
    if (Node.isNewExpression(call)) return { kind: 'unknown' };
    if (site && site.owner && site.name !== 'new') {
      const { cls, owner, name, decl } = site;
      const moduleId = cls && this.moduleIds.get(cls);
      if (cls && moduleId && cls !== this.currentClass && Node.isMethodDeclaration(decl) && decl.getScope() === MemberScope.Public) {
        return { kind: 'op', opId: `${owner}.${name}` };
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
      return node ? this.literal(node) : undefined;
    }
    if (spec.startsWith('url:')) return this.urlTarget(argNode(args, spec.slice(4)));
    if (spec === 'receiver') return site.receiver && Node.isPropertyAccessExpression(site.receiver) ? site.receiver.getName() : site.receiver?.getText();
    if (spec === 'injected') return this.injectedName(site.receiver);
    if (spec === 'entity') {
      const typeArg = site.receiver?.getType().getTypeArguments()[0];
      const fromArg = args[0] && (this.classOf(args[0]) ?? args[0].getType().getSymbol()?.getDeclarations()[0]);
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
    const value = this.literal(node);
    let text = value;
    if (value.startsWith('<') && Node.isTemplateExpression(node)) {
      text = node.getHead().getLiteralText() + node.getTemplateSpans().map((s) => `{${lastName(s.getExpression())}}${s.getLiteral().getLiteralText()}`).join('');
    } else if (value.startsWith('<')) {
      return undefined;
    }
    const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(text);
    return m ? m[1] : text.replace(/[?#].*$/, '');
  }

  /**
   * Resolves a call to who declares what it calls: `x.method()` to its class (following interfaces to their single
   * module implementation), interface or type alias; `fn()` / `ns.fn()` to the function and its npm package.
   */
  private site(call: Invocation): Site | undefined {
    if (this.siteCache.has(call)) return this.siteCache.get(call);
    const site = this.computeSite(call);
    this.siteCache.set(call, site);
    return site;
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
      const path = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'].map((p) => join(this.repoRoot, p)).find(existsSync);
      this.codeowners = (path ? readFileSync(path, 'utf8') : '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => {
          const [pattern, ...owners] = l.split(/\s+/);
          const anchored = pattern.startsWith('/') ? pattern.slice(1) : pattern.includes('/') ? pattern : `**/${pattern}`;
          return [globToRegex(anchored.endsWith('/') ? `${anchored}**` : anchored), owners.join(' ')] as [RegExp, string];
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
    return fn.getParameters().map((p) => ({ name: p.getName(), type: typeText(p.getType(), fn) }));
  }

  private shape(type: Type, at: Node): TypeShape {
    const t = type.getNonNullableType();
    const shape: TypeShape = { type: typeText(type, at) };
    if (t.isObject() && !t.isArray() && t.getCallSignatures().length === 0 && !t.isUnion()) {
      shape.fields = t.getProperties().slice(0, 16).map((p) => ({ name: p.getName(), type: typeText(p.getTypeAtLocation(at), at) }));
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

function methodsOf(rule: CallMatch): string[] {
  return Array.isArray(rule.method) ? rule.method : rule.method.split('|');
}

function matches(rule: CallMatch, site: CallSite): boolean {
  return (
    (rule.class === undefined || rule.class.split('|').includes(site.owner)) &&
    (rule.module === undefined || rule.module.split('|').includes(site.pkg)) &&
    methodsOf(rule).includes(site.name)
  );
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
function collectionName(model: string): string {
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

function exits(stmt: Node): boolean {
  if (Node.isReturnStatement(stmt) || Node.isThrowStatement(stmt)) return true;
  if (Node.isBlock(stmt)) {
    const last = stmt.getStatements().at(-1);
    return !!last && (Node.isReturnStatement(last) || Node.isThrowStatement(last));
  }
  return false;
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
  let text = type.getText(at, TypeFormatFlags.UseAliasDefinedOutsideCurrentScope).replace(/import\("[^"]+"\)\./g, '');
  // `status: KycStatus` hides which values exist; adding one is a contract change callers must handle.
  const members = type.getNonNullableType().isUnion() ? type.getNonNullableType().getUnionTypes() : [];
  if (members.length > 1 && members.length <= 12 && members.every((m) => m.isLiteral()) && !text.includes('"')) {
    text += ` [${members.map((m) => m.getText()).join(' | ')}]`;
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

