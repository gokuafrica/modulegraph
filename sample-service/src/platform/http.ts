import { createServer } from 'node:http';

export interface Request {
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
}
type RouteHandler = (req: Request) => Promise<unknown>;
type Stub = (path: string, body?: unknown) => unknown;

/** Outbound HTTP to other services. `service` names the dependency for the side-effect graph. */
export class HttpClient {
  private stubs = new Map<string, Stub>();

  stub(service: string, fn: Stub): void {
    this.stubs.set(service, fn);
  }

  async get<T>(service: string, path: string): Promise<T> {
    return this.call(service, path) as T;
  }

  async post<T>(service: string, path: string, body: unknown): Promise<T> {
    return this.call(service, path, body) as T;
  }

  private call(service: string, path: string, body?: unknown): unknown {
    const stub = this.stubs.get(service);
    if (!stub) throw new Error(`no stub for ${service}`);
    return stub(path, body);
  }
}

/** Inbound REST routes. */
export class HttpRouter {
  private routes: { method: string; pattern: string; handler: RouteHandler }[] = [];

  get(pattern: string, handler: RouteHandler): void { this.routes.push({ method: 'GET', pattern, handler }); }
  post(pattern: string, handler: RouteHandler): void { this.routes.push({ method: 'POST', pattern, handler }); }
  put(pattern: string, handler: RouteHandler): void { this.routes.push({ method: 'PUT', pattern, handler }); }
  delete(pattern: string, handler: RouteHandler): void { this.routes.push({ method: 'DELETE', pattern, handler }); }

  async dispatch(method: string, url: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const { pathname, searchParams } = new URL(url, 'http://local');
    for (const route of this.routes) {
      const params = matchPath(route.pattern, pathname);
      if (route.method !== method || !params) continue;
      const result = await route.handler({ params, query: Object.fromEntries(searchParams), body });
      return { status: 200, body: result };
    }
    return { status: 404, body: { error: 'not found' } };
  }

  listen(port: number): void {
    createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', async () => {
        try {
          const out = await this.dispatch(req.method ?? 'GET', req.url ?? '/', raw ? JSON.parse(raw) : undefined);
          res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
        } catch (err) {
          res.writeHead(500).end(JSON.stringify({ error: String(err) }));
        }
      });
    }).listen(port);
  }
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}
