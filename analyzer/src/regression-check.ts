/**
 * Regression checks for silent misses on NestJS services: changes that once produced "Verdict: not blocked" while
 * they opened endpoints or added writes. Each scenario edits a throwaway git copy of fixtures/frameworks/nest the
 * way a PR would, runs the real CLI on it (full and lazy), and checks what the review says.
 *   R1  the service's node_modules are missing: the analysis must say it is incomplete, not report "no effects"
 *   R2  the global AuthGuard no longer throws: access control changed on every entry point
 *   R3  @UseGuards(RolesGuard) removed from a controller: access control changed on its entry points
 *   R4  a TypeORM QueryBuilder write: a new db.write, not "implementation only"
 *   R5  lazy callersOf finds callers in the same class (OrdersService.resolveHold → release / cancel)
 *   R6  two classes with the same name: operations stay apart, calls reach the right one
 * usage: npx tsx src/regression-check.ts [R2,R3]   (part of npm test; the argument runs only those)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleGraph } from '../../schema/modulegraph.ts';
import { typescript } from './analyzers/typescript/index.ts';
import { loadConfig } from './config.ts';
import { effectKey } from './effects.ts';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../..').replace(/\\/g, '/');
const fixture = join(app, 'fixtures/frameworks/nest');
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'modulegraph-regression-'))).replace(/\\/g, '/');
const env = { ...process.env, MODULEGRAPH_HOME: join(scratch, 'home') };

let failures = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✓' : '✖'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  if (!cond) failures++;
};

type Edit = readonly [file: string, find: string, replace: string];

/** A git repo holding a copy of the fixture on `main`, with or without (a link to) installed packages. */
function makeRepo(name: string, withPackages: boolean): string {
  const dir = join(scratch, name).replace(/\\/g, '/');
  mkdirSync(dir, { recursive: true });
  for (const f of ['src', 'package.json', 'tsconfig.json']) cpSync(join(fixture, f), join(dir, f), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  if (withPackages) symlinkSync(join(app, 'node_modules'), join(dir, 'node_modules'), 'junction');
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '-m', 'store-service');
  return dir;
}

/** A branch off main with the edits committed (the PR). */
function branch(dir: string, name: string, message: string, edits: readonly Edit[]): void {
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('checkout', '-q', '-b', name, 'main');
  for (const [file, find, replace] of edits) {
    const path = join(dir, file);
    const text = readFileSync(path, 'utf8');
    if (!text.includes(find)) throw new Error(`${name}: "${find}" not found in ${file}`);
    writeFileSync(path, text.replace(find, replace));
  }
  g('-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '-am', message);
  g('checkout', '-q', 'main');
}

/** Runs `modulegraph analyze` like an agent would; returns its output, the graph and the brief. */
function analyze(dir: string, id: string, extra: string[]): { stdout: string; code: number; graph: ModuleGraph; brief: string } {
  const out = join(scratch, `${id}.json`);
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(here, 'cli.ts'), '--project', dir, '--out', out, '--no-examples', ...extra], {
    cwd: resolve(here, '..'), env, encoding: 'utf8',
  });
  const stdout = `${r.stdout}${r.stderr}`;
  if (!existsSync(out)) throw new Error(`analyze ${id} wrote nothing:\n${stdout}`);
  return { stdout, code: r.status ?? 1, graph: JSON.parse(readFileSync(out, 'utf8')), brief: readFileSync(out.replace(/\.json$/, '.brief.md'), 'utf8') };
}

const verdict = (brief: string) => /\*\*Verdict: [^*]*\*\*/.exec(brief)?.[0] ?? '(no verdict)';
const findings = (g: ModuleGraph, rule: string) => g.findings.filter((f) => f.isNew && f.rule === rule);
const allFindings = (g: ModuleGraph) => JSON.stringify(g.findings.filter((f) => f.isNew).map((x) => `${x.severity} ${x.rule}: ${x.message}`));

let storeRepo: string | undefined;
/** The fixture with its packages, shared by the scenarios that need them (each makes its own branch). */
const store = () => (storeRepo ??= makeRepo('store', true));

const QB_WRITE: Edit = [
  'src/orders/orders.service.ts',
  '    if (!order) throw new NotFoundException();\n    return order;',
  "    if (!order) throw new NotFoundException();\n    await this.orders.createQueryBuilder().update().set({ status: 'pending' }).where('id = :id', { id }).execute();\n    return order;",
];

const scenarios: Record<string, () => void> = {
  R1() {
    console.log('\nR1: node_modules missing');
    const dir = makeRepo('r1', false);
    branch(dir, 'r1', 'Orders: re-open an order when it is read', [QB_WRITE]);
    const r = analyze(dir, 'r1', ['--head', 'r1', '--base', 'main']);
    ok('the CLI says the analysis is incomplete', /analysis incomplete/i.test(r.stdout), r.stdout.split('\n').slice(0, 14).join('\n      '));
    ok('the CLI names the packages that do not resolve', /@nestjs\/common/.test(r.stdout) && /typeorm/.test(r.stdout));
    ok('the graph records why', !!r.graph.incomplete?.some((i) => i.kind === 'unresolved-imports'));
    ok("the brief's verdict says INCOMPLETE", /INCOMPLETE/.test(verdict(r.brief)), verdict(r.brief));
    const at = r.brief.toLowerCase().indexOf('incomplete');
    ok('the brief explains it before the changes', at >= 0 && at < r.brief.indexOf('## Changes'));
    const strict = analyze(dir, 'r1-check', ['--head', 'r1', '--base', 'main', '--check']);
    ok('--check fails on an incomplete analysis', strict.code !== 0);
  },

  R2() {
    console.log('\nR2: the global AuthGuard no longer throws');
    const dir = store();
    branch(dir, 'r2', 'Auth: tolerate missing sessions', [['src/common/auth.guard.ts', '    if (!session) throw new UnauthorizedException();\n', '']]);
    for (const lazy of [false, true]) {
      const label = lazy ? 'lazy' : 'full';
      const r = analyze(dir, `r2-${label}`, ['--head', 'r2', '--base', 'main', ...(lazy ? ['--lazy'] : [])]);
      const f = findings(r.graph, 'access-control-changed');
      ok(`${label}: error-level access-control-changed naming AuthGuard`, f.some((x) => x.severity === 'error' && /AuthGuard/.test(x.message)), allFindings(r.graph));
      const changed = Object.values(r.graph.entryPoints).filter((e) => e.change === 'modified').length;
      ok(`${label}: every entry point behind the global guard is changed (${changed})`, changed === Object.keys(r.graph.entryPoints).length && changed >= 17);
      ok(`${label}: verdict BLOCKING`, /BLOCKING/.test(verdict(r.brief)), verdict(r.brief));
      ok(`${label}: the brief names the guard`, /access control/i.test(r.brief) && /AuthGuard/.test(r.brief));
    }
  },

  R3() {
    console.log('\nR3: @UseGuards(RolesGuard) removed from OrdersController');
    const dir = store();
    branch(dir, 'r3', 'Orders: simplify the controller', [['src/orders/orders.controller.ts', '@UseGuards(RolesGuard)\n', '']]);
    for (const lazy of [false, true]) {
      const label = lazy ? 'lazy' : 'full';
      const r = analyze(dir, `r3-${label}`, ['--head', 'r3', '--base', 'main', ...(lazy ? ['--lazy'] : [])]);
      const f = findings(r.graph, 'access-control-changed');
      ok(`${label}: error-level access-control-changed naming RolesGuard`, f.some((x) => x.severity === 'error' && /RolesGuard/.test(x.message)), allFindings(r.graph));
      const entries = Object.values(r.graph.entryPoints);
      const orders = entries.filter((e) => e.file.endsWith('orders.controller.ts'));
      ok(`${label}: all ${orders.length} OrdersController entry points changed (−RolesGuard), and only those`,
        orders.length === 7 && orders.every((e) => e.change === 'modified' && e.pipelineDelta?.removed.some((p) => /RolesGuard/.test(p))) &&
        entries.filter((e) => e.change !== 'unchanged').length === 7,
        orders.map((e) => `${e.label} ${e.change} ${JSON.stringify(e.pipelineDelta)}`).join('; '));
      ok(`${label}: ${r.graph.review.stats.entryPointsAffected} entry points affected`, r.graph.review.stats.entryPointsAffected === 7);
      ok(`${label}: verdict BLOCKING`, /BLOCKING/.test(verdict(r.brief)), verdict(r.brief));
    }
  },

  R4() {
    console.log('\nR4: a QueryBuilder write in OrdersService.get');
    const dir = store();
    branch(dir, 'r4', 'Orders: re-open an order when it is read', [QB_WRITE]);
    for (const lazy of [false, true]) {
      const label = lazy ? 'lazy' : 'full';
      const r = analyze(dir, `r4-${label}`, ['--head', 'r4', '--base', 'main', ...(lazy ? ['--lazy'] : [])]);
      const get = Object.values(r.graph.operations).find((op) => op.file.endsWith('orders/orders.service.ts') && op.name === 'get');
      ok(`${label}: OrdersService.get gains db.write orders`, !!get?.delta?.effectsAdded.some((e) => effectKey(e) === 'db.write orders'), JSON.stringify(get?.delta));
      ok(`${label}: high risk, not implementation only`, get?.delta?.risk === 'high' && !get.delta.implementationOnly);
      ok(`${label}: read-path-writes on GET /api/v1/orders/:id`,
        findings(r.graph, 'read-path-writes').some((f) => f.message.includes('db.write `orders`') && f.message.includes('GET /api/v1/orders/:id')), allFindings(r.graph));
    }
  },

  // R5, R6: lazy questions answered like full analysis.
  R5R6() {
    console.log('\nR5/R6: lazy analysis vs full analysis on the fixture');
    const config = loadConfig(fixture);
    const full = typescript.open({ repo: app, projectDir: fixture, config }).run();
    const callers = new Map<string, Set<string>>();
    for (const [id, scope] of Object.entries(full.scopes)) {
      for (const s of scope.steps) if (s.target && s.target !== id) callers.set(s.target, new Set([...(callers.get(s.target) ?? []), id]));
    }
    const lazy = typescript.open({ repo: app, projectDir: fixture, config });
    lazy.init();
    lazy.listEntryPoints();
    const mismatches: string[] = [];
    for (const opId of Object.keys(full.operations)) {
      const want = [...(callers.get(opId) ?? [])].sort();
      const got = lazy.callersOf(opId).sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push(`${opId}: callersOf ${JSON.stringify(got)} ≠ full ${JSON.stringify(want)}`);
    }
    ok('R5: callersOf(op) = the scopes that call it in full analysis, for every operation', !mismatches.length, mismatches.join('\n      '));
    const opOf = (file: string, name: string) => Object.values(full.operations).find((op) => op.file.endsWith(file) && op.name === name)?.id ?? `${file}#${name}`;
    const release = opOf('/orders/orders.service.ts', 'release');
    const resolveHold = opOf('/orders/orders.service.ts', 'resolveHold');
    ok(`R5: callersOf(${release}) includes ${resolveHold}`, lazy.callersOf(release).includes(resolveHold));

    for (const name of ['get', 'cancel']) {
      const x = opOf('/orders/orders.service.ts', name);
      const y = opOf('/legacy/orders.service.ts', name);
      ok(`R6: ${name} of the two OrdersService classes are two operations (${x} / ${y})`, x !== y && !!full.operations[x] && !!full.operations[y]);
    }
    const effects = (id: string) => full.entryPoints[id]?.effects.map(effectKey).sort().join(', ') ?? '(no such entry point)';
    const legacyCancel = effects('api:POST /api/legacy/orders/:id/cancel');
    ok('R6: POST /api/legacy/orders/:id/cancel writes legacy_orders, not orders', /db\.write legacy_orders/.test(legacyCancel) && !/db\.write orders/.test(legacyCancel), legacyCancel);
    const ordersGet = effects('api:GET /api/v1/orders/:id');
    ok('R6: GET /api/v1/orders/:id reads orders, not legacy_orders', /db\.read orders/.test(ordersGet) && !/legacy/.test(ordersGet), ordersGet);
    const lazyOps = typescript.open({ repo: app, projectDir: fixture, config });
    lazyOps.init();
    const wrong: string[] = [];
    for (const [id, op] of Object.entries(full.operations)) {
      if (!lazyOps.ensureOp(id)) { wrong.push(`${id} not found`); continue; }
      const got = lazyOps.snapshot.operations[id];
      if (got.file !== op.file || got.directEffects.map(effectKey).join() !== op.directEffects.map(effectKey).join()) wrong.push(`${id}: lazy ${got.file} ${got.directEffects.map(effectKey)} ≠ full ${op.file} ${op.directEffects.map(effectKey)}`);
    }
    ok('R6: ensureOp(id) analyzes the same class as full analysis, for every operation', !wrong.length, wrong.join('\n      '));
  },
};

const only = process.argv[2]?.split(',');
try {
  for (const [name, scenario] of Object.entries(scenarios)) if (!only || only.some((o) => name.includes(o))) scenario();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} regression check(s) failed` : '\nno silent misses: R1–R6 all reported');
process.exit(failures ? 1 : 0);
