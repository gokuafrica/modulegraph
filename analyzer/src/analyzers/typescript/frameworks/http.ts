import { Node, SyntaxKind, type CallExpression } from 'ts-morph';
import { joinPath } from '../extract.ts';
import type { CallSite, Framework, HookContext } from './types.ts';

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'];
const READ = new Set(['get', 'head', 'options']);

/**
 * Express (4 and 5): `app.get('/x', …handlers)`, `router.post(…)`, `router.route('/x').get(…)`. Routers mounted
 * with `app.use('/prefix', router)` get the prefix. Handlers answer with `res.json(x)` / `res.send(x)`.
 */
export const express: Framework = {
  id: 'express',
  name: 'Express',
  packages: ['express'],
  entryPoints: VERBS.map((verb) => ({
    class: 'IRouter|Application|Router|Express|IRoute',
    method: verb,
    kind: 'api' as const,
    label: '{verb} {path}',
    handler: 'last',
    readOnly: READ.has(verb),
  })),
  responses: [{ class: 'Response', method: ['json', 'send', 'jsonp'], arg: 0 }],
  hooks: {
    entryVars(site, ctx) {
      if (!['IRouter', 'Application', 'Router', 'Express', 'IRoute'].includes(site.owner)) return undefined;
      let receiver = site.receiver;
      let routePath: string | undefined;
      // router.route('/orders/:id').get(h)
      if (receiver && Node.isCallExpression(receiver) && calleeIs(receiver, 'route')) {
        routePath = ctx.literal(receiver.getArguments()[0]);
        const inner = receiver.getExpression();
        receiver = Node.isPropertyAccessExpression(inner) ? inner.getExpression() : undefined;
      }
      const own = routePath ?? ctx.literal(site.call.getArguments()[0]);
      return { path: joinPath(mountPrefix(receiver, ctx, 'use'), own) };
    },
  },
};

/**
 * Fastify: `fastify.get('/x', opts?, handler)`, `fastify.route({ method, url, handler })`. Plugins registered
 * with `fastify.register(plugin, { prefix: '/x' })` prefix their routes. Handlers return or `reply.send(x)`.
 */
export const fastify: Framework = {
  id: 'fastify',
  name: 'Fastify',
  packages: ['fastify'],
  entryPoints: [
    ...VERBS.map((verb) => ({
      class: 'FastifyInstance',
      method: verb,
      kind: 'api' as const,
      label: '{verb} {path}',
      handler: 'last',
      readOnly: READ.has(verb),
    })),
    { class: 'FastifyInstance', method: 'route', kind: 'api', label: '{0.method} {path}', handler: 'arg:0.handler' },
  ],
  responses: [{ class: 'FastifyReply', method: 'send', arg: 0 }],
  hooks: {
    entryVars(site, ctx) {
      if (site.owner !== 'FastifyInstance') return undefined;
      const args = site.call.getArguments();
      const first = args[0];
      let own = ctx.literal(first);
      if (first && Node.isObjectLiteralExpression(first)) {
        const url = first.getProperty('url');
        own = url && Node.isPropertyAssignment(url) ? ctx.literal(url.getInitializer()) : '?';
      }
      return { path: joinPath(pluginPrefix(site, ctx), own) };
    },
  },
};

function calleeIs(call: CallExpression, name: string): boolean {
  const expr = call.getExpression();
  return Node.isPropertyAccessExpression(expr) && expr.getName() === name;
}

/** Prefix under which an Express router is mounted: `app.use('/orders', ordersRouter)`, nested up to 4 levels. */
function mountPrefix(receiver: Node | undefined, ctx: HookContext, useName: string, depth = 0): string {
  if (!receiver || depth > 4) return '';
  const decl = ctx.resolve(receiver);
  if (!decl) return '';
  for (const use of ctx.callsNamed(useName)) {
    const args = use.getArguments();
    if (args.length < 2 || !args.slice(1).some((a) => routerDecls(a, ctx).includes(decl))) continue;
    const prefix = ctx.literal(args[0]);
    if (prefix.startsWith('<') || prefix === '?') continue;
    const outer = use.getExpression();
    const parent = Node.isPropertyAccessExpression(outer) ? mountPrefix(outer.getExpression(), ctx, useName, depth + 1) : '';
    return joinPath(parent, prefix);
  }
  return '';
}

/** What a `use` argument mounts: the router variable itself, or what a router factory (`invoicesRouter(deps)`) returns. */
function routerDecls(arg: Node, ctx: HookContext): Node[] {
  if (!Node.isCallExpression(arg)) return [ctx.resolve(arg)].filter((d): d is Node => !!d);
  const fn = ctx.resolve(arg.getExpression());
  if (!fn || !(Node.isFunctionDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) return [];
  return fn.getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .map((r) => r.getExpression())
    .flatMap((e) => (e ? [ctx.resolve(e)] : []))
    .filter((d): d is Node => !!d);
}

/** Prefix of the Fastify plugin a route is declared in: `app.register(ordersRoutes, { prefix: '/orders' })`. */
function pluginPrefix(site: CallSite, ctx: HookContext): string {
  const fn = site.call.getFirstAncestor((n) => Node.isFunctionDeclaration(n) || Node.isArrowFunction(n) || Node.isFunctionExpression(n));
  if (!fn) return '';
  const named = Node.isFunctionDeclaration(fn) ? fn : fn.getParent();
  for (const reg of ctx.callsNamed('register')) {
    const [plugin, opts] = reg.getArguments();
    if (!plugin || !opts || !Node.isObjectLiteralExpression(opts)) continue;
    const target = ctx.resolve(plugin);
    if (target !== fn && target !== named) continue;
    const p = opts.getProperty('prefix');
    const value = p && Node.isPropertyAssignment(p) ? ctx.literal(p.getInitializer()) : '';
    return value.startsWith('<') || value === '?' ? '' : value;
  }
  return '';
}

/** axios (`axios.get(url)`, instances from `axios.create`) and the global `fetch`. The target is the URL's host. */
export const axios: Framework = {
  id: 'axios',
  name: 'axios',
  packages: ['axios', '@nestjs/axios'],
  sinks: [
    { class: 'Axios|AxiosInstance|AxiosStatic', module: 'axios', method: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'], kind: 'http', target: 'url:0' },
    { class: 'Axios|AxiosInstance|AxiosStatic', module: 'axios', method: 'request', kind: 'http', target: 'url:0.url' },
  ],
};

export const fetchApi: Framework = {
  id: 'fetch',
  name: 'fetch',
  packages: [],
  always: true,
  sinks: [{ module: 'global', method: 'fetch', kind: 'http', target: 'url:0' }],
};
