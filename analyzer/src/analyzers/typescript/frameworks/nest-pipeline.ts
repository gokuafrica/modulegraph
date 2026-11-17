import { type ClassDeclaration, type Decorator, type MethodDeclaration, Node, SyntaxKind } from 'ts-morph';
import type { HookContext, PipelineSpec } from './types.ts';

/**
 * NestJS's request pipeline, per handler: middleware (`configure(consumer) { consumer.apply(M).forRoutes(…) }`),
 * guards, interceptors, pipes and exception filters, each global (`app.useGlobalGuards(…)`, an `APP_GUARD`
 * provider), on the controller class or on the method (`@UseGuards(…)`), and the route metadata guards read
 * (`@SetMetadata`, `@Public()`, `@Roles([…])`, also inside `applyDecorators`).
 *
 * Global enhancers are applied to every handler of a controller, resolver or gateway: an over-approximation for
 * microservice handlers in hybrid apps (Nest needs `inheritAppConfig` there), which errs on the side of showing.
 */

type Kind = PipelineSpec['kind'];
type Scope = PipelineSpec['scope'];

const ENHANCER_DECORATORS: Record<string, Kind> = { UseGuards: 'guard', UseInterceptors: 'interceptor', UsePipes: 'pipe', UseFilters: 'filter' };
const GLOBAL_CALLS: Record<string, Kind> = { useGlobalGuards: 'guard', useGlobalInterceptors: 'interceptor', useGlobalPipes: 'pipe', useGlobalFilters: 'filter' };
const APP_TOKENS: Record<string, Kind> = { APP_GUARD: 'guard', APP_INTERCEPTOR: 'interceptor', APP_PIPE: 'pipe', APP_FILTER: 'filter' };
/** The method Nest calls on each kind of enhancer. */
const RUNS: Record<Kind, string> = { middleware: 'use', guard: 'canActivate', interceptor: 'intercept', pipe: 'transform', filter: 'catch', metadata: '' };
/** Classes whose handlers go through the pipeline. */
const HOSTS = new Set(['Controller', 'Resolver', 'WebSocketGateway']);
const ORDER: Kind[] = ['middleware', 'guard', 'interceptor', 'pipe', 'filter', 'metadata'];
const SCOPES: Scope[] = ['global', 'controller', 'method'];

export function nestPipeline(method: MethodDeclaration, cls: ClassDeclaration, vars: Record<string, string>, ctx: HookContext): PipelineSpec[] | undefined {
  const host = cls.getDecorators().find((d) => HOSTS.has(d.getName()) && ctx.decoratorFrom(d).startsWith('@nestjs/'));
  if (!host) return undefined;
  const specs: PipelineSpec[] = [...ctx.memo('nest:global-enhancers', () => globalEnhancers(ctx))];
  if (host.getName() === 'Controller') {
    for (const config of ctx.memo('nest:middleware', () => middlewareConfigs(ctx))) if (config.applies(cls, vars)) specs.push(...config.specs);
  }
  specs.push(...decorated(cls, 'controller', ctx), ...decorated(method, 'method', ctx));
  // Stable: within a kind and scope, the order they are declared in (the order Nest runs them).
  return specs
    .map((s, i) => ({ s, i }))
    .sort((a, b) => ORDER.indexOf(a.s.kind) - ORDER.indexOf(b.s.kind) || SCOPES.indexOf(a.s.scope) - SCOPES.indexOf(b.s.scope) || a.i - b.i)
    .map(({ s }) => s);
}

function decorated(node: ClassDeclaration | MethodDeclaration, scope: Scope, ctx: HookContext): PipelineSpec[] {
  return node.getDecorators().flatMap((d) => fromDecorator(d, scope, ctx));
}

/** `@UseGuards(A, new B())`, `@SetMetadata('k', v)`, or a project decorator built from those. */
function fromDecorator(d: Decorator, scope: Scope, ctx: HookContext): PipelineSpec[] {
  const name = d.getName();
  if (ctx.decoratorFrom(d).startsWith('@nestjs/')) {
    const kind = ENHANCER_DECORATORS[name];
    if (kind) return d.getArguments().flatMap((a) => component(a, kind, scope, d, ctx));
    if (name === 'SetMetadata') return [{ kind: 'metadata', name: squash(d.getText()), scope, at: d }];
    return [];
  }
  const callee = d.getCallExpression()?.getExpression() ?? d.getExpression();
  const def = ctx.resolve(callee);
  if (!def || !ctx.isProjectCode(def)) return [];
  const made = madeOf(def, ctx, 0);
  const out: PipelineSpec[] = made.components.map(([kind, arg]) => component(arg, kind, scope, d, ctx)).flat();
  // Metadata a guard reads: what matters is the value as written where it is used.
  if (made.metadata) out.push({ kind: 'metadata', name: squash(d.getText()), scope, at: d });
  return out;
}

/** What a project decorator is built from: enhancers it applies, and whether it sets route metadata. */
function madeOf(def: Node, ctx: HookContext, depth: number): { components: [Kind, Node][]; metadata: boolean } {
  const result = { components: [] as [Kind, Node][], metadata: false };
  if (depth > 3) return result;
  let body: Node | undefined = def;
  if (Node.isVariableDeclaration(def)) body = def.getInitializer();
  if (!body) return result;
  const calls = Node.isCallExpression(body) ? [body, ...body.getDescendantsOfKind(SyntaxKind.CallExpression)] : body.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of calls) {
    const expr = call.getExpression();
    const name = Node.isPropertyAccessExpression(expr) ? expr.getName() : expr.getText();
    if (name === 'SetMetadata' || name === 'createDecorator') result.metadata = true;
    else if (ENHANCER_DECORATORS[name]) for (const a of call.getArguments()) result.components.push([ENHANCER_DECORATORS[name], a]);
    else if (Node.isIdentifier(expr)) {
      // Another project decorator factory used inside this one.
      const inner = ctx.resolve(expr);
      if (inner && inner !== def && ctx.isProjectCode(inner) && !Node.isClassDeclaration(inner)) {
        const sub = madeOf(inner, ctx, depth + 1);
        result.components.push(...sub.components);
        result.metadata ||= sub.metadata;
      }
    }
  }
  return result;
}

/** An enhancer argument: `AuthGuard`, `new ValidationPipe()`, a variable holding one, or a functional middleware. */
function component(arg: Node, kind: Kind, scope: Scope, at: Node, ctx: HookContext): PipelineSpec[] {
  let name = squash(arg.getText(), 40);
  let decl: Node | undefined;
  if (Node.isNewExpression(arg)) {
    name = arg.getExpression().getText();
    decl = ctx.resolve(arg.getExpression());
  } else if (Node.isIdentifier(arg) || Node.isPropertyAccessExpression(arg)) {
    decl = ctx.resolve(arg);
    if (decl && Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init && Node.isNewExpression(init)) {
        name = init.getExpression().getText();
        decl = ctx.resolve(init.getExpression());
      }
    }
  } else if (Node.isCallExpression(arg)) {
    // A mixin such as `AuthGuard('jwt')` from @nestjs/passport: the name says what it is.
    name = squash(arg.getText(), 40);
  }
  let fn: Node | undefined;
  if (decl && Node.isClassDeclaration(decl)) {
    name = decl.getName() ?? name;
    const run = decl.getMethod(RUNS[kind]);
    if (run && ctx.isProjectCode(run)) fn = run;
  } else if (decl && kind === 'middleware' && (Node.isFunctionDeclaration(decl) || Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) && ctx.isProjectCode(decl)) {
    fn = decl;
  }
  return [{ kind, name, scope, at, ...(fn ? { fn } : {}) }];
}

/** `app.useGlobalGuards(…)` and `{ provide: APP_GUARD, useClass: … }` providers. */
function globalEnhancers(ctx: HookContext): PipelineSpec[] {
  const out: PipelineSpec[] = [];
  for (const [callName, kind] of Object.entries(GLOBAL_CALLS)) {
    for (const call of ctx.callsNamed(callName)) for (const a of call.getArguments()) out.push(...component(a, kind, 'global', call, ctx));
  }
  for (const file of ctx.projectFiles()) {
    for (const p of file.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      if (p.getName() !== 'provide') continue;
      const kind = APP_TOKENS[p.getInitializer()?.getText() ?? ''];
      const obj = p.getParent();
      if (!kind || !Node.isObjectLiteralExpression(obj)) continue;
      for (const key of ['useClass', 'useExisting', 'useValue', 'useFactory']) {
        const prop = obj.getProperty(key);
        if (!prop || !Node.isPropertyAssignment(prop)) continue;
        const value = key === 'useFactory' ? returned(prop.getInitializer()) : prop.getInitializer();
        if (value) out.push(...component(value, kind, 'global', obj, ctx));
      }
    }
  }
  return out;
}

/** What a factory returns: `() => new X()`, or the `return` of a block body. */
export function returned(fn: Node | undefined): Node | undefined {
  if (!fn || !(Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) return undefined;
  const body = fn.getBody();
  if (!Node.isBlock(body)) return body;
  return body.getDescendantsOfKind(SyntaxKind.ReturnStatement).find((r) => r.getFirstAncestor((n) => n === fn || Node.isFunctionLikeDeclaration(n)) === fn)?.getExpression();
}

interface MiddlewareConfig {
  specs: PipelineSpec[];
  applies(cls: ClassDeclaration, vars: Record<string, string>): boolean;
}

/** Every `consumer.apply(A, B).exclude(…).forRoutes(…)` chain in the project. */
function middlewareConfigs(ctx: HookContext): MiddlewareConfig[] {
  const out: MiddlewareConfig[] = [];
  for (const forRoutes of ctx.callsNamed('forRoutes')) {
    const routes = forRoutes.getArguments();
    const excludes: Node[] = [];
    const specs: PipelineSpec[] = [];
    let cur: Node = forRoutes.getExpression();
    while (Node.isPropertyAccessExpression(cur)) {
      const call = cur.getExpression();
      if (!Node.isCallExpression(call)) break;
      const callee = call.getExpression();
      const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : '';
      if (name === 'exclude') excludes.push(...call.getArguments());
      else if (name === 'apply') specs.push(...call.getArguments().flatMap((a) => component(a, 'middleware', 'global', forRoutes, ctx)));
      cur = callee;
    }
    if (!specs.length) continue;
    out.push({
      specs,
      applies: (cls, vars) => routes.some((r) => routeMatches(r, cls, vars, ctx)) && !excludes.some((r) => routeMatches(r, undefined, vars, ctx)),
    });
  }
  return out;
}

/** A `forRoutes` / `exclude` argument against one route: a controller class, a path, or `{ path, method }`. */
function routeMatches(route: Node, cls: ClassDeclaration | undefined, vars: Record<string, string>, ctx: HookContext): boolean {
  const path = (vars.routePath ?? vars.path ?? '').replace(/^\/+/, '');
  if (Node.isObjectLiteralExpression(route)) {
    const p = route.getProperty('path');
    const m = route.getProperty('method');
    const pathOk = p && Node.isPropertyAssignment(p) ? pattern(ctx.literal(p.getInitializer())).test(path) : true;
    const method = m && Node.isPropertyAssignment(m) ? m.getInitializer()?.getText().split('.').pop() : undefined;
    return pathOk && (!method || method === 'ALL' || method === vars.verb);
  }
  if (Node.isStringLiteral(route) || Node.isNoSubstitutionTemplateLiteral(route)) return pattern(route.getLiteralValue()).test(path);
  const decl = ctx.resolve(route);
  return !!cls && decl === cls;
}

/** A middleware route pattern (`orders`, `orders/*`, `*`, `orders/:id`) as a regex over the route path. Matches the path and below. */
function pattern(p: string): RegExp {
  const clean = p.replace(/^\/+|\/+$/g, '');
  if (/^(\*|\(\.\*\)|\{\*\w+\}|\*\w+|)$/.test(clean)) return /.*/;
  const re = clean.split('/').map((seg) =>
    /^(\*|\(\.\*\)|\{\*\w+\}|\*\w+)$/.test(seg) ? '.*' : seg.startsWith(':') ? '[^/]+' : seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'),
  ).join('/');
  return new RegExp(`^${re}(/.*)?$`);
}

function squash(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
