import { type ClassDeclaration, type MethodDeclaration, Node, SyntaxKind } from 'ts-morph';
import { returned } from './nest-pipeline.ts';
import type { CallSite, Framework, HookContext } from './types.ts';

/**
 * Nest custom providers: `{ provide: TOKEN, useClass | useExisting | useValue: new X() | useFactory: () => new X() }`
 * in any module's `providers`, and what injects them: `@Inject(TOKEN) dep`, or a constructor parameter typed with the
 * token class (an abstract class bound to an implementation). A call on `this.dep` then resolves to the bound class.
 * Bindings Nest builds at runtime (a factory that picks a class from config) stay unresolved.
 */

interface Binding {
  cls?: ClassDeclaration;
  /** The provider object literal. */
  at: Node;
}

/** Tokens compare by value for strings (`'PAYMENT_GATEWAY'`, or a const holding it), by declaration otherwise. */
function tokenKey(node: Node, ctx: HookContext): string | undefined {
  const value = ctx.literal(node);
  if (!value.startsWith('<') && value !== '?') return `value:${value}`;
  const decl = ctx.resolve(node);
  return decl ? declKey(decl) : undefined;
}

function declKey(decl: Node): string {
  return `decl:${decl.getSourceFile().getFilePath()}:${decl.getStart()}`;
}

/** The token a constructor parameter or property is injected with. */
function injectionKey(decl: Node, ctx: HookContext): string | undefined {
  if (!(Node.isParameterDeclaration(decl) || Node.isPropertyDeclaration(decl))) return undefined;
  const inject = decl.getDecorators().find((d) => d.getName() === 'Inject' && ctx.decoratorFrom(d).startsWith('@nestjs/'));
  const token = inject?.getArguments()[0];
  if (token) return tokenKey(token, ctx);
  const typeDecl = decl.getType().getSymbol()?.getDeclarations()[0];
  return typeDecl && Node.isClassDeclaration(typeDecl) ? declKey(typeDecl) : undefined;
}

/** Every custom provider in the project, by token. */
function providers(ctx: HookContext): Map<string, Binding[]> {
  const out = new Map<string, Binding[]>();
  for (const file of ctx.projectFiles()) {
    for (const p of file.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      if (p.getName() !== 'provide') continue;
      const obj = p.getParent();
      const token = p.getInitializer();
      if (!Node.isObjectLiteralExpression(obj) || !token || /^APP_(GUARD|INTERCEPTOR|PIPE|FILTER)$/.test(token.getText())) continue;
      const key = tokenKey(token, ctx);
      if (!key) continue;
      let cls: ClassDeclaration | undefined;
      for (const name of ['useClass', 'useExisting', 'useValue', 'useFactory']) {
        const prop = obj.getProperty(name);
        if (!prop || !Node.isPropertyAssignment(prop)) continue;
        let value = name === 'useFactory' ? returned(prop.getInitializer()) : prop.getInitializer();
        if (value && Node.isAwaitExpression(value)) value = value.getExpression();
        if (value && Node.isNewExpression(value)) value = value.getExpression();
        const decl = value && ctx.resolve(value);
        if (decl && Node.isClassDeclaration(decl)) cls = decl;
      }
      out.set(key, [...(out.get(key) ?? []), { cls, at: obj }]);
    }
  }
  return out;
}

/** The single class a token is bound to; undefined when no provider (or providers disagree) binds it. */
function boundClass(key: string, ctx: HookContext): ClassDeclaration | undefined {
  const classes = new Set((ctx.memo('nest:providers', () => providers(ctx)).get(key) ?? []).map((b) => b.cls));
  const [only] = classes;
  return classes.size === 1 ? only : undefined;
}

export function implementation(receiver: Node, ctx: HookContext): ClassDeclaration | undefined {
  if (!Node.isPropertyAccessExpression(receiver) || receiver.getExpression().getKind() !== SyntaxKind.ThisKeyword) return undefined;
  const decl = ctx.resolve(receiver);
  const key = decl && injectionKey(decl, ctx);
  return key ? boundClass(key, ctx) : undefined;
}

/** A changed provider entry: the classes that inject its token (their calls on it now go elsewhere). */
export function consumersAt(node: Node, ctx: HookContext): ClassDeclaration[] | undefined {
  const obj = node.getFirstAncestor((n) => Node.isObjectLiteralExpression(n) && !!n.getProperty('provide'));
  if (!obj || !Node.isObjectLiteralExpression(obj)) return undefined;
  const provide = obj.getProperty('provide');
  const token = provide && Node.isPropertyAssignment(provide) ? provide.getInitializer() : undefined;
  const key = token && tokenKey(token, ctx);
  if (!key) return undefined;
  const out: ClassDeclaration[] = [];
  for (const file of ctx.projectFiles()) {
    for (const cls of file.getClasses()) {
      const params = cls.getConstructors()[0]?.getParameters() ?? [];
      if ([...params, ...cls.getProperties()].some((d) => injectionKey(d, ctx) === key)) out.push(cls);
    }
  }
  return out;
}

const HANDLERS: Record<string, { decorator: string; method: string }> = {
  CommandBus: { decorator: 'CommandHandler', method: 'execute' },
  QueryBus: { decorator: 'QueryHandler', method: 'execute' },
  EventBus: { decorator: 'EventsHandler', method: 'handle' },
};

/** Message class → handler methods, from `@CommandHandler(X)`, `@QueryHandler(X)`, `@EventsHandler(X, Y)`. */
function handlers(ctx: HookContext): Map<Node, MethodDeclaration[]> {
  const out = new Map<Node, MethodDeclaration[]>();
  for (const file of ctx.projectFiles()) {
    for (const cls of file.getClasses()) {
      for (const d of cls.getDecorators()) {
        const spec = Object.values(HANDLERS).find((h) => h.decorator === d.getName());
        if (!spec || ctx.decoratorFrom(d) !== '@nestjs/cqrs') continue;
        const method = cls.getMethod(spec.method);
        if (!method) continue;
        for (const arg of d.getArguments()) {
          const message = ctx.resolve(arg);
          if (message) out.set(message, [...(out.get(message) ?? []), method]);
        }
      }
    }
  }
  return out;
}

/** The message classes a bus call sends: `new X(…)`, a variable holding one, or (publishAll) an array of them. */
function messages(arg: Node | undefined, ctx: HookContext): Node[] {
  if (!arg) return [];
  if (Node.isArrayLiteralExpression(arg)) return arg.getElements().flatMap((e) => messages(e, ctx));
  if (Node.isNewExpression(arg)) return [ctx.resolve(arg.getExpression())].filter((d): d is Node => !!d);
  const typeDecl = arg.getType().getSymbol()?.getDeclarations()[0];
  return typeDecl && Node.isClassDeclaration(typeDecl) ? [typeDecl] : [];
}

/**
 * @nestjs/cqrs: `commandBus.execute(new X())`, `queryBus.execute(new Y())` and `eventBus.publish(new Z())` /
 * `publishAll([…])` are calls into the handlers registered for those classes. Handlers are modules.
 */
export const nestCqrs: Framework = {
  id: 'nestjs-cqrs',
  name: 'NestJS CQRS',
  packages: ['@nestjs/cqrs'],
  moduleDecorators: ['CommandHandler', 'QueryHandler', 'EventsHandler'],
  hooks: {
    dispatchNames: ['execute', 'publish', 'publishAll'],
    dispatch(site: CallSite, ctx: HookContext) {
      if (site.pkg !== '@nestjs/cqrs' || !HANDLERS[site.owner]) return undefined;
      if (!(site.name === 'execute' || (site.owner === 'EventBus' && (site.name === 'publish' || site.name === 'publishAll')))) return undefined;
      const index = ctx.memo('nest:cqrs-handlers', () => handlers(ctx));
      const wanted = HANDLERS[site.owner].method;
      return messages(site.call.getArguments()[0], ctx).flatMap((m) => (index.get(m) ?? []).filter((h) => h.getName() === wanted));
    },
  },
};
