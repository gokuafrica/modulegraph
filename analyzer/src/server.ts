import { createServer, type IncomingMessage } from 'node:http';
import type { ModuleGraph } from '../../schema/modulegraph.ts';
import type { ExpandAction, LazySession } from './lazy.ts';

const ACTIONS: ExpandAction[] = ['callers', 'reach', 'entry', 'op'];

/**
 * Keeps a lazy analysis warm (TypeScript program and type checker loaded) and answers the UI's expand requests.
 * The UI dev server proxies /api here. Every expansion is also written back to the graph JSON, so the static file
 * always holds what has been explored so far and can be shared as is.
 *
 *   GET  /api/health                     -> { ok, graphs: [id] }
 *   GET  /api/graphs/:id                 -> current graph
 *   POST /api/graphs/:id/expand {action, id}
 *        action: callers (one level up) | reach (all the way up) | entry (analyze a flow) | op (analyze downward)
 */
export function serve(session: LazySession, persist: (g: ModuleGraph) => void, graphId: string, port: number): void {
  let current = session.graph();
  current.lazy!.api = '/api';
  createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true, graphs: [graphId] });
      const m = /^\/api\/graphs\/([^/]+)(\/expand)?$/.exec(url.pathname);
      if (!m || m[1] !== graphId) return send(404, { error: `this server serves only ${graphId}` });
      if (req.method === 'GET' && !m[2]) return send(200, current);
      if (req.method === 'POST' && m[2]) {
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
  }).listen(port, () => console.log(`\nmodulegraph live analysis for ${graphId} on http://localhost:${port}/api (the UI proxies /api here)`));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}
