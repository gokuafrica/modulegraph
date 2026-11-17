/**
 * The realistic sample as a real repo has it: copied to a folder outside the modulegraph repo, its own git history
 * (main, then the two commits of fix/scope-manual-data-to-row), `npm ci` from its own lockfile (Jest, Babel and
 * TypeORM in one node_modules: lru-cache 5 on top, path-scurry's 10 nested). Then the CLI as an agent runs it:
 *   - `--head fix/…` with main checked out (the head's code in a temporary worktree): examples are recorded;
 *   - the branch checked out (`--base main`, the checkout itself): examples are recorded;
 *   - nothing is left in the copy (no worktree, no .modulegraph-tmp), and its node_modules are intact.
 * Fails on "Tests: 0 total". In-house packages are copied next to it, as `file:../packages/…` expects.
 * usage: npm run standalone-check --workspace analyzer
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleGraph } from '../../schema/modulegraph.ts';
import { git } from './git.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const SAMPLE = 'sample-legacy-nest-service';
const BRANCH = 'fix/scope-manual-data-to-row';
let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  ✖ ${msg}`);
};
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

const tmp = mkdtempSync(join(tmpdir(), 'mg-standalone-'));
const svc = join(tmp, 'user-records-service');
const show = (rev: string, path: string) => execFileSync('git', ['show', `${rev}:${path}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
const writeFrom = (rev: string, path: string) => {
  const target = join(svc, path.slice(SAMPLE.length + 1));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, show(rev, path));
};

try {
  console.log(`\n${SAMPLE} as a standalone repo outside modulegraph (${tmp.replace(/\\/g, '/')})`);
  cpSync(join(repo, 'packages'), join(tmp, 'packages'), { recursive: true, filter: (src) => !/node_modules/.test(src) });
  for (const path of git(repo, ['ls-tree', '-r', '--name-only', 'main', SAMPLE]).split('\n').filter(Boolean)) writeFrom('main', path);
  const g = (...args: string[]) => git(svc, args);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: svc });
  g('config', 'user.email', 'check@example.com');
  g('config', 'user.name', 'check');
  g('add', '-A');
  g('commit', '-q', '-m', 'user-records-service');
  g('checkout', '-q', '-b', BRANCH);
  for (const commit of git(repo, ['rev-list', '--reverse', `main..${BRANCH}`]).split('\n').filter(Boolean)) {
    for (const line of git(repo, ['diff-tree', '--no-commit-id', '--name-status', '-r', commit, '--', SAMPLE]).split('\n').filter(Boolean)) {
      const [status, path] = line.split('\t');
      if (status === 'D') rmSync(join(svc, path.slice(SAMPLE.length + 1)), { force: true });
      else writeFrom(commit, path);
    }
    g('add', '-A');
    g('commit', '-q', '-m', git(repo, ['log', '-1', '--format=%s', commit]).trim());
  }
  g('checkout', '-q', 'main');
  const ci = spawnSync('npm ci --no-audit --no-fund', { cwd: svc, shell: true, encoding: 'utf8' });
  if (ci.status !== 0) throw new Error(`npm ci failed: ${ci.stderr.slice(-500)}`);
  const version = (p: string) => (JSON.parse(readFileSync(join(svc, 'node_modules', p, 'package.json'), 'utf8')) as { version: string }).version;
  const nested = existsSync(join(svc, 'node_modules/path-scurry/node_modules/lru-cache')) ? 'path-scurry/node_modules/lru-cache' : 'typeorm/node_modules/lru-cache';
  ok(`npm ci: lru-cache ${version('lru-cache')} on top, ${nested} ${version(nested)}`);
  const installed = readdirSync(join(svc, 'node_modules')).length;

  const run = (label: string, args: string[]) => {
    const out = join(tmp, `${label}.json`);
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(here, 'cli.ts'), '--project', svc, ...args, '--lazy', '--out', out], {
      cwd: join(repo, 'analyzer'),
      encoding: 'utf8',
      env: { ...process.env, MODULEGRAPH_HOME: join(tmp, 'home') },
    });
    if (r.status !== 0) {
      fail(`${label}: the CLI failed: ${(r.stderr || r.stdout).slice(-400)}`);
      return;
    }
    const graph = JSON.parse(readFileSync(out, 'utf8')) as ModuleGraph;
    const ex = graph.source.examples;
    if (!ex?.tests || !ex.cases?.length) fail(`${label}: no examples (${ex?.tests ?? 0} tests): ${ex?.note ?? 'no note'}`);
    else ok(`${label}: ${ex.cases.length} test cases from ${ex.tests} tests`);
  };
  run('worktree', ['--head', BRANCH, '--base', 'main']);
  g('checkout', '-q', BRANCH);
  run('checkout', ['--base', 'main']);

  if (existsSync(join(svc, '.modulegraph-tmp'))) fail('.modulegraph-tmp left in the repo');
  if (g('worktree', 'list').split('\n').filter(Boolean).length !== 1) fail(`worktrees left: ${g('worktree', 'list')}`);
  if (readdirSync(join(svc, 'node_modules')).length !== installed) fail('the repo\'s node_modules changed');
  if (!failures) ok('nothing left behind; node_modules intact');
} catch (err) {
  fail(String(err));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} problem(s) on the standalone sample` : '\na standalone install records examples from its tests, from a worktree and from the checkout');
process.exit(failures ? 1 : 0);
