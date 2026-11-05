import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import type { ModuleGraph } from '../../schema/modulegraph.ts';
import type { ExpandAction, LazySession } from './lazy.ts';

const ACTIONS: ExpandAction[] = ['callers', 'reach', 'entry', 'op'];

export interface RefreshResult {
  /** False when the code is the same as at the last analysis (nothing was re-analyzed). */
  changed: boolean;
  /** Repo paths whose text changed since the last analysis, on either side. */
  files: string[];
  /** The base side's analysis was reused (its code didn't change). */
  baseKept?: boolean;
  ms: number;
  graph: ModuleGraph;
}

export interface ServeOptions {
  persist: (g: ModuleGraph) => void;
  graphId: string;
  port: number;
  /** Re-reads the code and re-analyzes what changed. */
  refresh: () => RefreshResult;
  /** Cheap check (git only, no analysis): has the code changed since the last analysis? */
  stale: () => boolean;
  /** Where this review's graph files are (served at /graphs/). */
  graphsDir: string;
  /** The built UI, served at /. Without it, the UI dev server (npm run dev) proxies /api here. */
  uiDir?: string;
  /** Open the review in the browser once the server is up. */
  open?: boolean;
}

export interface StaticOptions {
  /** Folders with graph files, served at /graphs/ (the first that has a file wins; index.json lists them all). */
  graphsDirs: string[];
  uiDir?: string;
}

/** Only this machine can connect: the review shows the service's code. */
const HOST = '127.0.0.1';
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

/**
 * Keeps a lazy analysis warm (TypeScript program and type checker loaded) and answers the UI's requests. It also
 * serves the built UI and the graph files, so one address is the whole review; the UI dev server (npm run dev)
 * proxies /api here instead. Every expansion and refresh is also written back to the graph JSON, so the static
 * file always holds what has been explored so far and can be shared as is.
 *
 *   GET  /api/health                     -> { ok, graphs: [id] }
 *   GET  /api/graphs/:id                 -> current graph
 *   GET  /api/graphs/:id/status          -> { stale }: the code changed since the last analysis
 *   POST /api/graphs/:id/refresh         -> { changed, files, baseKept, ms, graph }: re-analyze after code changes
 *   POST /api/graphs/:id/expand {action, id}
 *        action: callers (one level up) | reach (all the way up) | entry (analyze a flow) | op (analyze downward)
 *   GET  /graphs/<file>, /<ui file>      -> this review's saved files, the built UI
 */
export function serve(session: LazySession, opts: ServeOptions): void {
  const { persist, graphId, port } = opts;
  let current = session.graph();
  current.lazy!.api = '/api';
  createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true, graphs: [graphId] });
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return sendFile(res, url.pathname, { graphsDirs: [opts.graphsDir], uiDir: opts.uiDir });
      const m = /^\/api\/graphs\/([^/]+)(?:\/(expand|refresh|status))?$/.exec(url.pathname);
      if (!m || m[1] !== graphId) return send(404, { error: `this server serves only ${graphId}` });
      if (req.method === 'GET' && !m[2]) return send(200, current);
      if (req.method === 'GET' && m[2] === 'status') return send(200, { stale: opts.stale() });
      if (req.method === 'POST' && m[2] === 'refresh') {
        const result = opts.refresh();
        current = result.graph;
        return send(200, result);
      }
      if (req.method === 'POST' && m[2] === 'expand') {
        const body = JSON.parse((await readBody(req)) || '{}') as { action?: ExpandAction; id?: string };
        if (!body.action || !ACTIONS.includes(body.action) || !body.id) return send(400, { error: 'expected { action, id }' });
        const t = performance.now();
        session.expand(body.action, body.id);
        current = session.graph();
        current.lazy!.api = '/api';
        persist(current);
        console.log(`expand ${body.action} ${body.id}: ${Math.round(performance.now() - t)} ms (${current.lazy!.stats.operationsAnalyzed} ops, ${current.lazy!.stats.entryPointsAnalyzed} flows analyzed)`);
        return send(200, current);
      }
      send(405, { error: 'method not allowed' });
    } catch (err) {
      console.error(err);
      send(500, { error: String(err) });
    }
  })
    .on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE') throw err;
      console.error(`\nport ${port} is in use: another review is probably being served. Stop it, or pass --port <n>.`);
      process.exit(2);
    })
    .listen(port, HOST, () => {
      const ui = !!opts.uiDir && existsSync(join(opts.uiDir, 'index.html'));
      const link = ui ? `http://${HOST}:${port}/#g=${graphId}` : `http://localhost:5173/#g=${graphId}`;
      console.log(`\nmodulegraph is serving the review of ${graphId}; only this machine can connect. Ctrl+C stops it.`);
      console.log(`open the review: ${link}`);
      if (!ui) console.log('(the UI is not built: run `npm run setup` in the modulegraph folder, or start it with `npm run dev`)');
      if (opts.open) openBrowser(link);
    });
}

/**
 * Serves saved reviews and the built UI, with no analysis behind them (`modulegraph open`). Lazy graphs show what
 * was explored when they were saved.
 */
export function serveStatic(opts: StaticOptions & { port: number; open?: string }): void {
  createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === '/api/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, graphs: [] }));
    if (url.pathname.startsWith('/api/')) return void res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'saved reviews only: run `modulegraph review` to analyze live' }));
    sendFile(res, url.pathname, opts);
  })
    .on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE') throw err;
      console.error(`port ${opts.port} is in use: a review is probably being served there already. Stop it, or pass --port <n>.`);
      process.exit(2);
    })
    .listen(opts.port, HOST, () => {
      const link = `http://${HOST}:${opts.port}/${opts.open ? `#g=${opts.open}` : ''}`;
      console.log(`modulegraph is showing saved reviews on ${link} (only this machine can connect; Ctrl+C stops it)`);
      openBrowser(link);
    });
}

/** Static files: /graphs/* from the graph folders, everything else from the built UI (a one-page app). */
function sendFile(res: ServerResponse, pathname: string, opts: StaticOptions): void {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const notFound = (text: string) => void res.writeHead(404, { 'content-type': 'text/plain' }).end(text);
  const inside = (root: string, file: string) => (file + sep).startsWith(resolve(root) + sep);
  if (rel.startsWith('graphs/')) {
    const name = rel.slice('graphs/'.length);
    if (name === 'index.json') {
      const lists = opts.graphsDirs.map((d) => join(d, 'index.json')).filter((f) => existsSync(f)).map((f) => JSON.parse(readFileSync(f, 'utf8')) as unknown[]);
      return void res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(lists.flat()));
    }
    const file = opts.graphsDirs.map((d) => resolve(d, name)).find((f, i) => inside(opts.graphsDirs[i], f) && existsSync(f) && statSync(f).isFile());
    if (!file) return notFound('not found');
    return void res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(file));
  }
  const root = opts.uiDir;
  if (!root || !existsSync(join(root, 'index.html'))) return notFound('the UI is not built: run `npm run setup` in the modulegraph folder');
  const file = resolve(root, rel || 'index.html');
  if (!inside(root, file)) return notFound('not found');
  // A one-page app: unknown paths get index.html.
  const found = existsSync(file) && statSync(file).isFile() ? file : join(root, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(found)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(found));
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd as string, args as string[], () => undefined);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}
