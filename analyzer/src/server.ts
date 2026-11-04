import { createServer, type IncomingMessage } from 'node:http';
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
}

/**
 * Keeps a lazy analysis warm (TypeScript program and type checker loaded) and answers the UI's requests.
 * The UI dev server proxies /api here. Every expansion and refresh is also written back to the graph JSON, so the
 * static file always holds what has been explored so far and can be shared as is.
 *
 *   GET  /api/health                     -> { ok, graphs: [id] }
 *   GET  /api/graphs/:id                 -> current graph
 *   GET  /api/graphs/:id/status          -> { stale }: the code changed since the last analysis
 *   POST /api/graphs/:id/refresh         -> { changed, files, baseKept, ms, graph }: re-analyze after code changes
 *   POST /api/graphs/:id/expand {action, id}
 *        action: callers (one level up) | reach (all the way up) | entry (analyze a flow) | op (analyze downward)
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
  }).listen(port, () => {
    console.log(`\nmodulegraph live analysis for ${graphId} on http://localhost:${port}/api (the UI proxies /api here)`);
    console.log(`open the review: http://localhost:5173/#g=${graphId}`);
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}
