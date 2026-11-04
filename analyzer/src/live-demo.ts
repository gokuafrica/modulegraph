/**
 * Starts live lazy analysis of the demo branches for the UI (http://localhost:5173 proxies /api to :5174).
 * usage: npm run live                      all three live demos (BirthInfo, KYC, NestJS orders) at once
 *        npm run live -- birthinfo|kyc|orders   just one
 * With several demos, each runs its own analysis server (one TypeScript program each) on 5175, 5176, …, and
 * :5174 routes every /api/graphs/<id> request to the server that owns <id>.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const identity = resolve(here, '../../configs/identity-profile-service');
const PORT = 5174;

interface Demo {
  id: string;
  args: string[];
}
const demos: Record<string, Demo> = {
  birthinfo: {
    id: 'live-birthinfo-consent',
    args: [
      '--project', resolve(here, '../../sample-service'),
      '--config', resolve(identity, 'modulegraph.config.json'), '--examples', resolve(identity, 'scenario.ts'),
      '--head', 'feature/birthinfo-consent', '--base', 'main',
      '--title', 'Live (lazy): BirthInfo consented data wins over documents',
      '--intent', 'BirthInfo: prefer user-consented birth data (birth_info_consents) over document data; add consent endpoint.',
    ],
  },
  kyc: {
    id: 'live-kyc-risk-tiers',
    args: [
      '--project', resolve(here, '../../sample-service'),
      '--config', resolve(identity, 'modulegraph.config.json'), '--examples', resolve(identity, 'scenario.ts'),
      '--head', 'feature/kyc-risk-tiers', '--base', 'main',
      '--title', 'Live (lazy): KYC risk tiers, manual review, async rescreen',
      '--intent', 'KYC: add risk tiers from sanctions score, birth country and nationality; send high-risk users to manual review (outbox kyc.manual_review_requested); make the nightly rescreen asynchronous via kyc.recheck_requested.',
    ],
  },
  // The NestJS demo: profile found by package name, intent from the branch's commits.
  orders: {
    id: 'live-order-fraud-hold',
    args: [
      '--project', resolve(here, '../../sample-nest-service'),
      '--head', 'feature/order-fraud-hold', '--base', 'main',
      '--title', 'Live (lazy, NestJS): hold high-risk orders for fraud review',
    ],
  },
};

const wanted = process.argv[2];
if (wanted && !demos[wanted]) {
  console.error(`unknown demo "${wanted}": use one of ${Object.keys(demos).join(', ')}, or nothing for all`);
  process.exit(2);
}
const picked = wanted ? [demos[wanted]] : Object.values(demos);

const children = picked.map((demo, i) => {
  const port = picked.length === 1 ? PORT : PORT + 1 + i;
  const child = spawn(process.execPath, [
    '--import', 'tsx', resolve(here, 'cli.ts'), ...demo.args, '--lazy', '--serve', '--port', String(port), '--name', demo.id,
  ], { stdio: 'inherit' });
  child.on('exit', (code) => {
    console.error(`${demo.id} analysis server stopped (exit ${code})`);
    process.exit(code ?? 1);
  });
  return { ...demo, port, child };
});
const stopAll = () => {
  for (const c of children) c.child.kill();
  process.exit(0);
};
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

if (children.length > 1) {
  // One address for the UI: route each graph's requests to the server that owns it.
  createServer(async (req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    const url = new URL(req.url ?? '/', 'http://local');
    const id = /^\/api\/graphs\/([^/]+)/.exec(url.pathname)?.[1];
    const owner = children.find((c) => c.id === id);
    try {
      if (url.pathname === '/api/health') {
        const up = await Promise.all(children.map((c) => fetch(`http://localhost:${c.port}/api/health`).then((r) => r.ok, () => false)));
        return send(200, { ok: up.every(Boolean), graphs: children.filter((_, i) => up[i]).map((c) => c.id), starting: children.filter((_, i) => !up[i]).map((c) => c.id) });
      }
      if (!owner) return send(404, { error: `no live analysis for ${id}; serving ${children.map((c) => c.id).join(', ')}` });
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const upstream = await fetch(`http://localhost:${owner.port}${url.pathname}${url.search}`, {
        method: req.method,
        headers: { 'content-type': 'application/json' },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(await upstream.text());
    } catch (err) {
      send(503, { error: `${owner?.id ?? id} is still starting or stopped: ${String(err)}` });
    }
  }).listen(PORT, () => console.log(`\nmodulegraph live: ${children.map((c) => c.id).join(', ')} on http://localhost:${PORT}/api (each starts in a few seconds)`));
}
