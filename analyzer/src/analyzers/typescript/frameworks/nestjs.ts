import { type ClassDeclaration, type Decorator, type MethodDeclaration, Node, SyntaxKind } from 'ts-morph';
import type { DecoratorEntryRule } from '../../../config.ts';
import { joinPath } from '../extract.ts';
import { consumersAt, implementation } from './nest-di.ts';
import { nestPipeline } from './nest-pipeline.ts';
import type { Framework, HookContext } from './types.ts';

const HTTP_VERBS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'];
const READ_VERBS = new Set(['Get', 'Head', 'Options']);

/**
 * NestJS: controllers and their route decorators (with the global prefix, RouterModule prefixes and URI
 * versioning), GraphQL resolvers, WebSocket gateways, microservice message/event handlers (Kafka and other
 * transports), gRPC methods, @nestjs/schedule jobs, BullMQ/Bull processors and @nestjs/event-emitter listeners.
 * Each handler's request pipeline (guards, interceptors, pipes, filters, middleware, auth metadata) is in
 * ./nest-pipeline.ts. Providers (`@Injectable`) are modules; controllers, processors and `@Module` classes host
 * entry points or wire things up, so they are not.
 */
export const nestjs: Framework = {
  id: 'nestjs',
  name: 'NestJS',
  packages: ['@nestjs/core', '@nestjs/common'],
  decoratorEntries: [
    ...HTTP_VERBS.map((verb): DecoratorEntryRule => ({
      decorator: verb,
      from: '@nestjs/common',
      classDecorator: 'Controller',
      kind: 'api',
      label: '{verb} {path}',
      readOnly: READ_VERBS.has(verb),
    })),
    { decorator: 'Query', from: '@nestjs/graphql', classDecorator: 'Resolver', kind: 'api', label: 'GraphQL query {gqlName}', readOnly: true },
    { decorator: 'Mutation', from: '@nestjs/graphql', classDecorator: 'Resolver', kind: 'api', label: 'GraphQL mutation {gqlName}' },
    { decorator: 'Subscription', from: '@nestjs/graphql', classDecorator: 'Resolver', kind: 'api', label: 'GraphQL subscription {gqlName}', readOnly: true },
    { decorator: 'ResolveField', from: '@nestjs/graphql', classDecorator: 'Resolver', kind: 'api', label: 'GraphQL field {gqlType}.{gqlName}', readOnly: true },
    { decorator: 'SubscribeMessage', from: '@nestjs/websockets', classDecorator: 'WebSocketGateway', kind: 'consumer', label: 'ws {0}' },
    { decorator: 'MessagePattern|EventPattern', from: '@nestjs/microservices', kind: 'consumer', label: 'topic {0}' },
    { decorator: 'GrpcMethod|GrpcStreamMethod', from: '@nestjs/microservices', kind: 'grpc', label: 'gRPC {0|class}/{1|Method}' },
    { decorator: 'Cron', from: '@nestjs/schedule', kind: 'cron', label: 'cron {1.name|method} ({0})' },
    { decorator: 'Interval', from: '@nestjs/schedule', kind: 'cron', label: 'cron {method} (every {1|0} ms)' },
    { decorator: 'Timeout', from: '@nestjs/schedule', kind: 'cron', label: 'cron {method} (once after {1|0} ms)' },
    { decorator: 'OnEvent', from: '@nestjs/event-emitter', kind: 'event', label: 'event {0}' },
    // @nestjs/bullmq: a @Processor('queue') class handles jobs in process(); @nestjs/bull: @Process('job') methods.
    { classDecorator: 'Processor', method: 'process', from: '@nestjs/bullmq', kind: 'queue', label: 'queue {class.0.name|class.0}' },
    { classDecorator: 'Processor', decorator: 'Process', from: '@nestjs/bull', kind: 'queue', label: 'queue {class.0.name|class.0} ({0.name|0|method})' },
  ],
  sinks: [
    { class: 'ClientProxy|ClientKafka|ClientKafkaProxy|ClientRMQ|ClientNats|ClientRedis|ClientMqtt|ClientTCP', method: ['emit', 'send'], kind: 'kafka', target: 'arg:0' },
    { class: 'HttpService', module: '@nestjs/axios', method: ['get', 'post', 'put', 'patch', 'delete', 'head'], kind: 'http', target: 'url:0' },
    { class: 'HttpService', module: '@nestjs/axios', method: 'request', kind: 'http', target: 'url:0.url' },
    { class: 'EventEmitter2', method: ['emit', 'emitAsync'], kind: 'event', target: 'arg:0' },
  ],
  moduleDecorators: ['Injectable'],
  notModuleDecorators: ['Module', 'Controller', 'Catch', 'Resolver', 'WebSocketGateway', 'Processor', 'Global', 'ObjectType', 'InputType', 'ArgsType'],
  notModuleImplements: ['CanActivate', 'PipeTransform', 'NestInterceptor', 'ExceptionFilter', 'NestMiddleware'],
  ignoreMethods: ['onModuleInit', 'onModuleDestroy', 'onApplicationBootstrap', 'beforeApplicationShutdown', 'onApplicationShutdown'],
  hooks: {
    /** `app.setGlobalPrefix('api')` in main.ts prefixes every route. */
    globalVars(ctx) {
      return { globalPrefix: globalPrefix(ctx) };
    },
    decoratorVars(method, cls, dec, ctx) {
      if (dec && HTTP_VERBS.includes(dec.getName()) && findDecorator(cls, 'Controller', ctx)) return routeVars(method, cls, dec, ctx);
      if (dec && ['Query', 'Mutation', 'Subscription', 'ResolveField'].includes(dec.getName())) return graphqlVars(method, cls, dec, ctx);
      return undefined;
    },
    pipeline: nestPipeline,
    implementation,
    consumersAt,
  },
};

/**
 * @nestjs/swagger: what the service says about its API, read as descriptions (after JSDoc). `@ApiOperation` on a
 * handler describes the entry point (and the operation it hands the request to); `@ApiProperty` describes DTO fields.
 */
export const nestSwagger: Framework = {
  id: 'nestjs-swagger',
  name: 'Swagger (@nestjs/swagger)',
  packages: ['@nestjs/swagger'],
  docDecorators: [{ decorator: 'ApiOperation', from: '@nestjs/swagger', props: ['description', 'summary'] }],
  fieldDocDecorators: [{ decorator: 'ApiProperty|ApiPropertyOptional|ApiResponseProperty', from: '@nestjs/swagger', props: ['description', 'title'] }],
};

function globalPrefix(ctx: HookContext): string {
  const call = ctx.callsNamed('setGlobalPrefix')[0];
  const value = call ? ctx.literal(call.getArguments()[0]) : '';
  return value.startsWith('<') || value === '?' ? '' : value;
}

/**
 * `/api/v1/admin/reports/daily`: global prefix, API version (URI versioning), RouterModule prefix of the
 * controller's module, controller path, method path. `routePath` leaves out the global prefix and version
 * (what middleware `forRoutes('reports')` is matched against).
 */
function routeVars(method: MethodDeclaration, cls: ClassDeclaration, dec: Decorator, ctx: HookContext): Record<string, string> {
  const controller = findDecorator(cls, 'Controller', ctx)!;
  const classArg = controller.getArguments()[0];
  const router = ctx.memo('nest:router-prefixes', () => routerPrefixes(ctx)).get(ctx.memo('nest:controller-modules', () => controllerModules(ctx)).get(cls)!) ?? '';
  const routePath = joinPath(router, pathOf(classArg, ctx), pathOf(dec.getArguments()[0], ctx));
  const v = ctx.memo('nest:versioning', () => versioning(ctx));
  let version = '';
  let suffix = '';
  if (v) {
    const own = findDecorator(method, 'Version', ctx)?.getArguments()[0];
    const fromClass = classArg && Node.isObjectLiteralExpression(classArg) ? propertyValue(classArg, 'version') : undefined;
    const versions = versionsOf(own ?? fromClass ?? v.defaultVersion, ctx);
    if (versions.length && v.uri) version = versions.length > 1 ? `{${versions.map((x) => `${v.prefix}${x}`).join(',')}}` : `${v.prefix}${versions[0]}`;
    else if (versions.length) suffix = ` [version ${versions.join(', ')}]`;
  }
  // `setGlobalPrefix('api', { exclude: ['health', { path: 'metrics', method: RequestMethod.GET }] })`
  const verb = dec.getName().toUpperCase();
  const excluded = ctx.memo('nest:prefix-excludes', () => globalPrefixExcludes(ctx)).some((x) => x.path.test(routePath.replace(/^\/+|\/+$/g, '')) && (!x.method || x.method === 'ALL' || x.method === verb));
  return { path: `${joinPath(excluded ? '' : globalPrefix(ctx), version, routePath)}${suffix}`, routePath };
}

/** Routes the global prefix leaves out: `setGlobalPrefix('api', { exclude: [...] })`. */
function globalPrefixExcludes(ctx: HookContext): { path: RegExp; method?: string }[] {
  const opts = ctx.callsNamed('setGlobalPrefix')[0]?.getArguments()[1];
  const list = opts && Node.isObjectLiteralExpression(opts) ? propertyValue(opts, 'exclude') : undefined;
  if (!list || !Node.isArrayLiteralExpression(list)) return [];
  const toRegex = (p: string) => new RegExp(`^${p.replace(/^\/+|\/+$/g, '').split('/').map((s) => (s.startsWith(':') ? '[^/]+' : s === '*' || s === '(.*)' ? '.*' : s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`);
  return list.getElements().flatMap((el) => {
    if (Node.isObjectLiteralExpression(el)) {
      const path = ctx.literal(propertyValue(el, 'path'));
      const method = propertyValue(el, 'method')?.getText().split('.').pop();
      return path.startsWith('<') || path === '?' ? [] : [{ path: toRegex(path), method }];
    }
    const path = ctx.literal(el);
    return path.startsWith('<') || path === '?' ? [] : [{ path: toRegex(path) }];
  });
}

interface Versioning {
  uri: boolean;
  prefix: string;
  defaultVersion?: Node;
}

/** `app.enableVersioning({ type: VersioningType.URI, prefix?, defaultVersion? })`. */
function versioning(ctx: HookContext): Versioning | undefined {
  const call = ctx.callsNamed('enableVersioning')[0];
  if (!call) return undefined;
  const opts = call.getArguments()[0];
  const type = opts && Node.isObjectLiteralExpression(opts) ? propertyValue(opts, 'type')?.getText() ?? '' : '';
  const prefixNode = opts && Node.isObjectLiteralExpression(opts) ? propertyValue(opts, 'prefix') : undefined;
  const prefix = !prefixNode ? 'v' : prefixNode.getText() === 'false' ? '' : ctx.literal(prefixNode).replace(/^<.*>$/, 'v');
  return { uri: !opts || /URI$/.test(type) || !type, prefix, defaultVersion: opts && Node.isObjectLiteralExpression(opts) ? propertyValue(opts, 'defaultVersion') : undefined };
}

/** `'1'`, `['1', '2']`; VERSION_NEUTRAL (or nothing) is no version. */
function versionsOf(node: Node | undefined, ctx: HookContext): string[] {
  if (!node || /VERSION_NEUTRAL/.test(node.getText())) return [];
  if (Node.isArrayLiteralExpression(node)) return node.getElements().flatMap((e) => versionsOf(e, ctx));
  const value = ctx.literal(node);
  return value.startsWith('<') || value === '?' ? [] : [value];
}

/** Module class → path prefix from `RouterModule.register([{ path, module, children }])`, nested. */
function routerPrefixes(ctx: HookContext): Map<Node, string> {
  const out = new Map<Node, string>();
  const walk = (routes: Node | undefined, prefix: string) => {
    if (!routes || !Node.isArrayLiteralExpression(routes)) return;
    for (const r of routes.getElements()) {
      if (!Node.isObjectLiteralExpression(r)) {
        // A bare module in `children` inherits the parent's path.
        const mod = ctx.resolve(r);
        if (mod && !out.has(mod)) out.set(mod, prefix);
        continue;
      }
      const path = joinPath(prefix, pathOf(propertyValue(r, 'path'), ctx));
      const modNode = propertyValue(r, 'module');
      const mod = modNode && ctx.resolve(modNode);
      if (mod) out.set(mod, path);
      walk(propertyValue(r, 'children'), path);
    }
  };
  for (const call of ctx.callsNamed('register')) {
    const callee = call.getExpression();
    if (Node.isPropertyAccessExpression(callee) && callee.getExpression().getText() === 'RouterModule') walk(call.getArguments()[0], '');
  }
  return out;
}

/** Controller class → the `@Module` class whose `controllers` list it. */
function controllerModules(ctx: HookContext): Map<Node, Node> {
  const out = new Map<Node, Node>();
  for (const file of ctx.projectFiles()) {
    for (const mod of file.getDescendantsOfKind(SyntaxKind.ClassDeclaration)) {
      const dec = findDecorator(mod, 'Module', ctx);
      const opts = dec?.getArguments()[0];
      const list = opts && Node.isObjectLiteralExpression(opts) ? propertyValue(opts, 'controllers') : undefined;
      if (!list || !Node.isArrayLiteralExpression(list)) continue;
      for (const c of list.getElements()) {
        const cls = ctx.resolve(c);
        if (cls) out.set(cls, mod);
      }
    }
  }
  return out;
}

/**
 * GraphQL names: `@Query(() => T, { name: 'orders' })` or `@ResolveField('customer', …)` or the method name;
 * the parent type of a field from `@Resolver(() => OrderType)` and that class's `@ObjectType('Order')`.
 */
function graphqlVars(method: MethodDeclaration, cls: ClassDeclaration, dec: Decorator, ctx: HookContext): Record<string, string> {
  const args = dec.getArguments();
  const literal = args.find((a) => Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a));
  const opts = args.find((a) => Node.isObjectLiteralExpression(a));
  const named = opts && Node.isObjectLiteralExpression(opts) ? propertyValue(opts, 'name') : undefined;
  const gqlName = literal ? ctx.literal(literal) : named ? ctx.literal(named) : method.getName();
  let gqlType = cls.getName() ?? '?';
  const target = findDecorator(cls, 'Resolver', ctx)?.getArguments()[0];
  if (target && (Node.isStringLiteral(target) || Node.isNoSubstitutionTemplateLiteral(target))) gqlType = target.getLiteralValue();
  else if (target && Node.isArrowFunction(target)) {
    const body = target.getBody();
    const typeCls = Node.isIdentifier(body) ? ctx.resolve(body) : undefined;
    if (typeCls && Node.isClassDeclaration(typeCls)) {
      const objectType = findDecorator(typeCls, 'ObjectType', ctx)?.getArguments().find((a) => Node.isStringLiteral(a));
      gqlType = objectType && Node.isStringLiteral(objectType) ? objectType.getLiteralValue() : typeCls.getName() ?? gqlType;
    }
  }
  return { gqlName, gqlType };
}

/** A decorator imported from a Nest package. */
function findDecorator(node: ClassDeclaration | MethodDeclaration, name: string, ctx: HookContext): Decorator | undefined {
  return node.getDecorators().find((d) => d.getName() === name && ctx.decoratorFrom(d).startsWith('@nestjs/'));
}

function propertyValue(obj: Node, name: string): Node | undefined {
  if (!Node.isObjectLiteralExpression(obj)) return undefined;
  const p = obj.getProperty(name);
  return p && Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
}

/** `'orders'`, `{ path: 'orders' }`, `['a', 'b']` (first) → the path segment; '' when absent. */
function pathOf(arg: Node | undefined, ctx: HookContext): string {
  if (!arg) return '';
  if (Node.isObjectLiteralExpression(arg)) return pathOf(propertyValue(arg, 'path'), ctx);
  if (Node.isArrayLiteralExpression(arg)) return pathOf(arg.getElements()[0], ctx);
  const value = ctx.literal(arg);
  return value === '?' ? '' : value;
}
