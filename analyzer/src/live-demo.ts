/**
 * Starts live lazy analysis of the demo branches for the UI (http://localhost:5173 proxies /api to :5174).
 * usage: npm run live                      the birth-info demo (sample-birth-service): the small one to start with
 *        npm run live -- all               every live demo at once (adds the identity-profile and order services)
 *        npm run live -- birthinfo|kyc|orders|birth|residency   just that one
 *        npm run live -- all --idle 60     stop after 60 min with no requests (default 30; 0 = never)
 * With several demos, each runs its own analysis server (one TypeScript program each) on 5175, 5176, …, and
 * :5174 routes every /api/graphs/<id> request to the server that owns <id>.
 * The servers stop with this process however it ends (they hold an IPC channel to it), and this process stops
 * when the last of them has stopped (idle, or `modulegraph done`/`stop`).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { ACTION_HEADER, DEFAULT_IDLE_MINUTES, idleShutdown, registerServer, trustedAction } from './servers.ts';
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
  // NestJS, with recorded examples (the profile's scenario.ts): KYC birth info must match the identity document.
  birth: {
    id: 'live-enforce-document-birth-info',
    args: [
      '--project', resolve(here, '../../sample-birth-service'),
      '--head', 'feature/enforce-document-birth-info', '--base', 'main',
      '--title', 'Live (lazy, NestJS): KYC birth info must match the identity document',
    ],
  },
  // The next change on top of the birth-info one, as if that had shipped: a new area (residency).
  residency: {
    id: 'live-residency-declaration',
    args: [
      '--project', resolve(here, '../../sample-birth-service'),
      '--head', 'feature/residency-declaration', '--base', 'feature/enforce-document-birth-info',
      '--title', 'Live (lazy, NestJS): users declare their home address during KYC',
    ],
  },
};

const cli = parseArgs({ options: { idle: { type: 'string' } }, allowPositionals: true });
const wanted = cli.positionals[0] ?? 'birth';
const idleMinutes = cli.values.idle === undefined ? DEFAULT_IDLE_MINUTES : Number(cli.values.idle);
if (!(idleMinutes >= 0)) {
  console.error('--idle takes a number of minutes (0 = never stop by itself)');
  process.exit(2);
}
if (wanted !== 'all' && !demos[wanted]) {
  console.error(`unknown demo "${wanted}": use one of ${Object.keys(demos).join(', ')}, or all`);
  process.exit(2);
}
const picked = wanted === 'all' ? [demos.birth, demos.birthinfo, demos.kyc, demos.orders] : [demos[wanted]];

const children = picked.map((demo, i) => ({ ...demo, port: picked.length === 1 ? PORT : PORT + 1 + i, child: undefined as ChildProcess | undefined, stopped: false }));
const healthy = (port: number) => fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false);

// One at a time: each analysis loads a TypeScript program and may check out a git worktree to record examples.
void (async () => {
  for (const c of children) {
    // The IPC channel ties the server to this process: it stops when this one goes, even after a hard kill on Windows.
    c.child = spawn(process.execPath, [
      '--import', 'tsx', resolve(here, 'cli.ts'), ...c.args, '--lazy', '--serve', '--port', String(c.port), '--name', c.id, '--idle', String(idleMinutes),
    ], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    c.child.on('exit', (code) => {
      c.stopped = true;
      // A clean stop (idle, done, stop) ends that demo only; a crash ends them all.
      if (code !== 0) {
        console.error(`${c.id} analysis server stopped (exit ${code})`);
        return stopAll(code ?? 1);
      }
      if (children.every((x) => x.stopped)) stopAll(0);
    });
    while (!c.stopped && !(await healthy(c.port))) await new Promise((r) => setTimeout(r, 500));
  }
})();
function stopAll(code = 0): never {
  for (const c of children) if (!c.stopped) c.child?.kill();
  process.exit(code);
}
process.on('SIGINT', () => stopAll());
process.on('SIGTERM', () => stopAll());

if (children.length > 1) {
  // One address for the UI: route each graph's requests to the server that owns it.
  const touch = idleShutdown(idleMinutes, (why) => {
    console.log(`\nmodulegraph live stopped: ${why}.`);
    stopAll(0);
  });
  const router = createServer(async (req, res) => {
    touch();
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    const url = new URL(req.url ?? '/', 'http://local');
    const id = /^\/api\/graphs\/([^/]+)/.exec(url.pathname)?.[1];
    const owner = children.find((c) => c.id === id && !c.stopped);
    try {
      if (url.pathname === '/api/health') {
        const up = await Promise.all(children.map((c) => !c.stopped && healthy(c.port)));
        return send(200, { ok: up.some(Boolean), pid: process.pid, graphs: children.filter((_, i) => up[i]).map((c) => c.id), starting: children.filter((c, i) => !up[i] && !c.stopped).map((c) => c.id) });
      }
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        if (!trustedAction(req)) return send(403, { error: 'shutdown needs the x-modulegraph header' });
        send(200, { ok: true });
        console.log('\nmodulegraph live stopped: asked to stop (modulegraph stop).');
        return void setTimeout(() => stopAll(0), 50);
      }
      if (!owner) return send(404, { error: `no live analysis for ${id}; serving ${children.filter((c) => !c.stopped).map((c) => c.id).join(', ')}` });
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const upstream = await fetch(`http://127.0.0.1:${owner.port}${url.pathname}${url.search}`, {
        method: req.method,
        // done is passed on only when this request itself was allowed to ask for it.
        headers: { 'content-type': 'application/json', ...(trustedAction(req) ? { [ACTION_HEADER]: String(req.headers[ACTION_HEADER]) } : {}) },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(await upstream.text());
    } catch (err) {
      send(503, { error: `${owner?.id ?? id} is still starting or stopped: ${String(err)}` });
    }
  });
  router.listen(PORT, '127.0.0.1', () => {
    registerServer({ port: PORT, ids: children.map((c) => c.id), kind: 'live-router', idleMinutes });
    console.log(`\nmodulegraph live: ${children.map((c) => c.id).join(', ')} on http://127.0.0.1:${PORT}/api (each starts in a few seconds)`);
    console.log(`Stops ${idleMinutes > 0 ? `after ${idleMinutes} min with no requests (--idle <minutes>)` : 'only when told to (--idle 0)'}, on Ctrl+C, or with \`modulegraph stop\`; each demo also stops on its own when idle.`);
  });
}
