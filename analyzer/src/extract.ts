import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  Node,
  Project,
  Scope as MemberScope,
  SyntaxKind,
  TypeFormatFlags,
  type ArrowFunction,
  type CallExpression,
  type ClassDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type Type,
} from 'ts-morph';
import type { CodeChange, Edge, Effect, EntryPoint, ModuleInfo, Operation, Param, Scope, Step, TypeShape } from '../../schema/modulegraph.ts';
import type { Config } from './config.ts';

type Fn = MethodDeclaration | FunctionDeclaration | ArrowFunction | FunctionExpression;
/** producer step id (or "entry") -> labels of the variables that carried the value */
type Prod = Map<string, Set<string>>;

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

type Resolved =
  | { kind: 'op'; opId: string }
  | { kind: 'sink'; effect: Effect }
  | { kind: 'inline'; fn: Fn; name: string }
  | { kind: 'unknown' };

interface FnResult {
  steps: Step[];
  edges: Edge[];
  returns: Prod;
  parts: Part[];
}

const MAX_TYPE = 110;

export function extract(project: Project, repoRoot: string, projectDir: string, config: Config): Snapshot {
  return new Extractor(project, repoRoot, projectDir, config).run();
}

/**
 * Turns code into the graph. Two ways to drive it:
 * - `run()`: everything (every operation, every entry point). Simple, and fine for small services.
 * - lazy (`init()` then `ensureOp` / `ensureEntry` / `callersOf` / `scopesForLines`): only what a review needs,
 *   found from the changed lines outwards with the TypeScript reference index. See lazy.ts.
 */
export class Extractor {
  private moduleIds = new Map<ClassDeclaration, string>();
  /** Registration call of every entry point found so far (lazy mode builds scopes from these on demand). */
  private entryCalls = new Map<string, CallExpression>();
  private entryIdCache = new Map<CallExpression, string | undefined>();
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
  ) {}

  run(): Snapshot {
    this.init();
    for (const [cls, moduleId] of this.moduleIds) this.extractOperations(cls, moduleId);
    for (const file of this.projectFiles()) for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) this.extractEntry(call);
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
  operationTargets(): { opId: string; file: string; className: string; method: string; params: string[] }[] {
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
   * Lists every entry point without analyzing any: finds the registration calls (router.get, consumer.subscribe, …)
   * through the reference index of the framework methods named in the config.
   */
  listEntryPoints(): void {
    for (const rule of this.config.entryPoints) {
      const method = this.projectFiles().map((f) => f.getClass(rule.class)).find(Boolean)?.getMethod(rule.method);
      if (!method) {
        // Framework class not in the project (e.g. from node_modules): fall back to scanning call sites.
        for (const file of this.projectFiles()) for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) this.entryStub(call);
        continue;
      }
      for (const ref of method.findReferencesAsNodes()) {
        const call = callOf(ref);
        if (call) this.entryStub(call);
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
    return this.scopesAt(node);
  }

  /**
   * Scopes whose steps would include something located at `node`: the entry handler or operation around it,
   * and, for helpers that get inlined, everything that calls the helper.
   */
  scopesAt(node: Node, seen = new Set<Node>()): string[] {
    for (let cur = node.getParent(); cur; cur = cur.getParent()) {
      if (Node.isCallExpression(cur)) {
        const id = this.entryIdOf(cur);
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
      const cls = fn.getParent();
      if (Node.isClassDeclaration(cls) && this.moduleIds.has(cls) && fn.getScope() === MemberScope.Public && !fn.isStatic()) {
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

  private entryIdOf(call: CallExpression): string | undefined {
    if (!this.entryIdCache.has(call)) this.entryIdCache.set(call, this.entryStub(call));
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
    return cls.getMethods().filter((m) => m.getScope() === MemberScope.Public && !m.getName().startsWith('#') && !m.isStatic());
  }

  // ---------- modules & operations ----------

  /**
   * Finds modules from code structure alone, so the analyzed repo needs no changes: a class is a module when it has
   * public methods and takes part in dependency injection (it is injected into another class, or injects collaborators
   * itself). Platform classes named by sink/entry rules are infrastructure, not modules. Config include/exclude and an
   * optional opt-in JSDoc tag adjust the result.
   */
  private discoverModules(classes: ClassDeclaration[]): ClassDeclaration[] {
    const key = (c: ClassDeclaration) => `${c.getSourceFile().getFilePath()}#${c.getName()}`;
    const platform = new Set([...this.config.sinks.map((s) => s.class), ...this.config.entryPoints.map((e) => e.class)]);
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
      const hasPublicMethods = cls.getMethods().some((m) => m.getScope() === MemberScope.Public && !m.isStatic());
      return hasPublicMethods && (injected.has(key(cls)) || injects.has(key(cls)));
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

  private extractOperations(cls: ClassDeclaration, _moduleId: string): void {
    for (const method of this.publicMethods(cls)) this.extractOperation(cls, method);
  }

  private extractOperation(cls: ClassDeclaration, method: MethodDeclaration): void {
    const moduleId = this.moduleIds.get(cls)!;
    {
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
  }

  // ---------- entry points ----------

  private extractEntry(call: CallExpression): void {
    const id = this.entryStub(call);
    if (id) this.buildEntry(id);
  }

  /** Registers an entry point from its registration call, without analyzing the handler. Returns its id. */
  private entryStub(call: CallExpression): string | undefined {
    const target = this.methodTarget(call);
    if (!target) return undefined;
    const rule = this.config.entryPoints.find((r) => r.class === target.className && r.method === target.method);
    if (!rule) return undefined;
    const args = call.getArguments();
    if (!this.toFn(args[rule.handlerArg])) return undefined;
    const label = rule.label.replace(/\{(\d+)\}/g, (_, i) => this.literal(args[Number(i)]));
    const id = `${rule.kind}:${label}`;
    if (this.entryCalls.has(id)) return id;
    this.entryCalls.set(id, call);
    this.snapshot.entryPoints[id] = {
      id,
      kind: rule.kind,
      label,
      readOnly: rule.readOnly ?? (rule.kind === 'grpc' && /\/(Get|List|Check)/.test(label)),
      file: this.rel(call.getSourceFile().getFilePath()),
      line: call.getStartLineNumber(),
      effects: [],
      change: 'unchanged',
      containsChanges: false,
    };
    return id;
  }

  private buildEntry(id: string): void {
    const call = this.entryCalls.get(id)!;
    const handler = this.toFn(call.getArguments()[this.ruleFor(call)!.handlerArg])!;
    const scope = this.buildScope(id, handler);
    const label = this.snapshot.entryPoints[id].label;
    this.recordParts(id, { name: label, role: 'handler', file: this.rel(call.getSourceFile().getFilePath()), line: call.getStartLineNumber(), text: call.getText() }, scope.result.parts);
  }

  private recordParts(id: string, own: Part, inlined: Part[]): void {
    const seen = new Set<string>();
    const parts = [own, ...inlined].filter((p) => !seen.has(p.name) && !!seen.add(p.name));
    this.snapshot.parts[id] = parts.map((p) => ({ ...p, text: dedent(p.text) }));
    this.snapshot.fingerprints[id] = normalise([own.text, ...inlined.map((p) => p.text)].join('\n'));
  }

  private toFn(node: Node | undefined): Fn | undefined {
    if (!node) return undefined;
    if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return node;
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
    const scope: Scope = {
      id,
      params: this.params(fn),
      returns: this.shape(unwrapPromise(fn.getReturnType()), fn),
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
    const vars = new Map<string, Prod>();
    const callProd = new Map<Node, Prod>();
    let returns: Prod = new Map();
    for (const p of fn.getParameters()) {
      for (const name of bindingNames(p.getNameNode())) vars.set(name, new Map([['entry', new Set()]]));
    }
    const body = fn.getBody();
    if (!body) return { steps, edges, returns, parts };

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

    const handleCall = (call: CallExpression) => {
      const resolved = this.resolve(call);
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
      }
    };

    const nodes = [body, ...body.getDescendants()];
    const events = nodes.filter(
      (n) =>
        Node.isCallExpression(n) ||
        Node.isVariableDeclaration(n) ||
        Node.isBinaryExpression(n) && n.getOperatorToken().getKind() === SyntaxKind.EqualsToken ||
        Node.isReturnStatement(n) && n.getFirstAncestor(isFnNode) === fn,
    );
    events.sort((a, b) => a.getEnd() - b.getEnd() || rank(a) - rank(b));
    for (const ev of events) {
      if (Node.isCallExpression(ev)) handleCall(ev);
      else if (Node.isVariableDeclaration(ev)) {
        const loop = ev.getParent()?.getParent();
        bind(ev.getNameNode(), Node.isForOfStatement(loop) || Node.isForInStatement(loop) ? loop.getExpression() : ev.getInitializer());
      }
      else if (Node.isBinaryExpression(ev)) bind(ev.getLeft(), ev.getRight());
      else if (Node.isReturnStatement(ev)) mergeInto(returns, prodOf(ev.getExpression()));
    }
    if (!Node.isBlock(body)) returns = prodOf(body);
    return { steps, edges, returns, parts };
  }

  // ---------- resolution ----------

  private resolve(call: CallExpression): Resolved {
    const target = this.methodTarget(call);
    if (target) {
      const { cls, className, method, decl } = target;
      const sink = this.config.sinks.find((s) => s.class === className && s.method === method);
      if (sink) {
        return {
          kind: 'sink',
          effect: {
            kind: sink.kind,
            target: this.literal(call.getArguments()[sink.targetArg]),
            file: this.rel(call.getSourceFile().getFilePath()),
            line: call.getStartLineNumber(),
          },
        };
      }
      const moduleId = cls && this.moduleIds.get(cls);
      if (cls && moduleId && cls !== this.currentClass && Node.isMethodDeclaration(decl) && decl.getScope() === MemberScope.Public) {
        return { kind: 'op', opId: `${className}.${method}` };
      }
      if (Node.isMethodDeclaration(decl) && decl.getBody() && this.isProjectFile(decl.getSourceFile().getFilePath())) {
        return { kind: 'inline', fn: decl, name: `${className}.${method}` };
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

  /** Resolves `x.method()` to its class and method, following interfaces to their single implementation. */
  private methodTarget(call: CallExpression) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return undefined;
    const decl = this.resolveDeclaration(expr);
    if (!decl || !(Node.isMethodDeclaration(decl) || Node.isMethodSignature(decl))) return undefined;
    const method = decl.getName();
    let parent = decl.getParent();
    if (Node.isInterfaceDeclaration(parent)) {
      const ifaceName = parent.getName();
      const impls = [...this.moduleIds.keys()].filter((c) => c.getImplements().some((i) => i.getExpression().getText() === ifaceName));
      if (impls.length !== 1) return { cls: undefined, className: ifaceName, method, decl };
      const implMethod = impls[0].getMethod(method);
      return { cls: impls[0], className: impls[0].getName() ?? ifaceName, method, decl: implMethod ?? decl };
    }
    if (!Node.isClassDeclaration(parent)) return undefined;
    return { cls: parent, className: parent.getName() ?? 'Anonymous', method, decl };
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

  // ---------- effects ----------

  private ruleFor(call: CallExpression) {
    const target = this.methodTarget(call);
    return target && this.config.entryPoints.find((r) => r.class === target.className && r.method === target.method);
  }

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

  private literal(arg: Node | undefined): string {
    if (!arg) return '?';
    if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) return arg.getLiteralValue();
    const type = arg.getType();
    if (type.isStringLiteral()) return String(type.getLiteralValue());
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

  private isProjectFile(path: string): boolean {
    return !path.includes('/node_modules/') && !path.endsWith('.d.ts') && !relative(this.projectDir, path).startsWith('..');
  }

  private rel(path: string): string {
    return relative(this.repoRoot, path).replace(/\\/g, '/');
  }
}

// ---------- pure helpers ----------

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
      else if (child === node.getElseStatement()) conditions.push(`unless (${cond})`);
      if (child !== node.getExpression()) guardNodes.push(node.getExpression());
    } else if (Node.isConditionalExpression(node)) {
      if (child !== node.getCondition()) guardNodes.push(node.getCondition());
      const cond = short(node.getCondition().getText(), 40);
      if (child === node.getWhenTrue()) conditions.push(`if (${cond})`);
      else if (child === node.getWhenFalse()) conditions.push(`unless (${cond})`);
    } else if (Node.isBinaryExpression(node) && child === node.getRight()) {
      const op = node.getOperatorToken().getKind();
      const left = short(node.getLeft().getText(), 40);
      if (op === SyntaxKind.QuestionQuestionToken) conditions.push(`if ${left} is missing`);
      else if (op === SyntaxKind.BarBarToken) conditions.push(`unless (${left})`);
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
          conditions.push(`unless (${short(stmt.getExpression().getText(), 40)})`);
          guardNodes.push(stmt.getExpression());
        }
      }
    }
    child = node;
    node = node.getParent();
  }
  return { condition: conditions.reverse().join(' and ') || undefined, loop: loop || undefined, guardNodes };
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
  return Node.isCallExpression(n) ? 0 : 1;
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

export function dedupeEffects(effects: Effect[]): Effect[] {
  const seen = new Map<string, Effect>();
  for (const e of effects) if (!seen.has(effectKey(e))) seen.set(effectKey(e), e);
  return [...seen.values()];
}

export function effectKey(e: Effect): string {
  return `${e.kind} ${e.target}`;
}

function unwrapPromise(type: Type): Type {
  return type.getSymbol()?.getName() === 'Promise' ? type.getTypeArguments()[0] ?? type : type;
}

function typeText(type: Type, at: Node): string {
  const text = type.getText(at, TypeFormatFlags.UseAliasDefinedOutsideCurrentScope).replace(/import\("[^"]+"\)\./g, '');
  return short(text, MAX_TYPE);
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
