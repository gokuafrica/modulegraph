/**
 * The testers' invariants (acceptance/round-3/invariants.mjs, unchanged: properties of ANY correct review, no names
 * in them) over every review this repo's samples and fixtures give, the way an agent runs the CLI:
 *   I1 every effect target is a name, never code or "?";  I2 one entry point per job / consumer / route;
 *   I3 no unknown entry point labels;  I4 every effect step names its target;
 *   I5 (Nest services) API entry points = route decorators in the source;
 *   I6 (here) a service with no profile: with the profile its first review suggests, applied as-is, nothing is
 *      incomplete, and the invariants still hold.
 * A shape that breaks a property then fails here, not on the testers' side.
 * usage: npm run invariants-check --workspace analyzer
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ModuleGraph } from '../../schema/modulegraph.ts';

type Result = { id: string; what: string; pass: boolean; detail: string };
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const { invariants } = (await import(pathToFileURL(join(repo, 'acceptance/round-3/invariants.mjs')).href)) as { invariants: (g: ModuleGraph, projectDir?: string) => Result[] };

interface Run {
  project: string;
  /** Branch to review (`--head`); the working tree when absent. */
  head?: string;
  lazy?: boolean;
  /** A profile to use instead of the repo's (copied into a fresh MODULEGRAPH_HOME). */
  profile?: string;
  /** Route decorators are the only API entry points (Nest): check I5. */
  routes?: boolean;
}

const runs: Run[] = [
  { project: 'sample-service', head: 'feature/birthinfo-consent' },
  { project: 'sample-service', head: 'feature/kyc-risk-tiers', lazy: true },
  { project: 'sample-nest-service', head: 'feature/order-fraud-hold', routes: true },
  { project: 'sample-nest-service', head: 'feature/order-fraud-hold', lazy: true, routes: true },
  { project: 'sample-birth-service', head: 'feature/enforce-document-birth-info', routes: true },
  { project: 'sample-birth-service', head: 'feature/enforce-document-birth-info', lazy: true, routes: true },
  { project: 'sample-legacy-nest-service', head: 'fix/scope-manual-data-to-row', profile: 'configs/user-records-service.rules/modulegraph.config.json', routes: true },
  { project: 'fixtures/frameworks' },
  { project: 'fixtures/frameworks', lazy: true },
];

const tmp = mkdtempSync(join(tmpdir(), 'mg-invariants-'));
let failures = 0;
let n = 0;

function analyze(run: Run, home: string): ModuleGraph {
  const out = join(tmp, `review-${++n}.json`);
  const args = ['--project', join(repo, run.project), ...(run.head ? ['--head', run.head] : []), ...(run.lazy ? ['--lazy'] : []), '--no-tests', '--out', out];
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'cli.ts'), ...args], { cwd: join(repo, 'analyzer'), stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MODULEGRAPH_HOME: home } });
  return JSON.parse(readFileSync(out, 'utf8')) as ModuleGraph;
}

function homeWith(service: string, profile?: string | object): string {
  const home = join(tmp, `home-${++n}`);
  if (profile) {
    mkdirSync(join(home, 'configs', service), { recursive: true });
    const file = join(home, 'configs', service, 'modulegraph.config.json');
    if (typeof profile === 'string') copyFileSync(join(repo, profile), file);
    else writeFileSync(file, JSON.stringify(profile, null, 2));
  }
  return home;
}

/** The project's `src` as the reviewed revision has it (I5 counts route decorators there, not in the working tree). */
function sourceAt(run: Run): string {
  if (!run.head) return join(repo, run.project);
  const dir = join(tmp, `src-${++n}`);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 });
  for (const file of git('ls-tree', '-r', '--name-only', run.head, '--', `${run.project}/src`).split('\n').filter((f) => f.endsWith('.ts'))) {
    const dest = join(dir, file.slice(run.project.length + 1));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, git('show', `${run.head}:${file}`));
  }
  return dir;
}

function report(title: string, g: ModuleGraph, run: Run) {
  console.log(`\n${title}`);
  for (const r of invariants(g, run.routes ? sourceAt(run) : undefined)) {
    if (!r.pass) failures++;
    console.log(`  ${r.pass ? '✓' : '✖'} [${r.id}] ${r.what}${r.pass ? '' : `\n        got: ${r.detail}`}`);
  }
}

const serviceOf = (project: string) => (JSON.parse(readFileSync(join(repo, project, 'package.json'), 'utf8')) as { name: string }).name;
const describeRun = (r: Run, extra = '') => `${r.project}${r.head ? ` --head ${r.head}` : ' (working tree)'}${r.lazy ? ' --lazy' : ''}${extra}`;

try {
  for (const run of runs) {
    const g = analyze(run, homeWith(serviceOf(run.project), run.profile));
    report(describeRun(run, run.profile ? ', profile from the repo' : ''), g, run);
  }

  // I6: a service with no profile, then with what its first review suggests, applied as-is.
  const legacy: Run = { project: 'sample-legacy-nest-service', head: 'fix/scope-manual-data-to-row', lazy: true, routes: true };
  const first = analyze(legacy, homeWith('none'));
  report(describeRun(legacy, ', no profile'), first, legacy);
  const suggested: Record<string, unknown> = { service: serviceOf(legacy.project) };
  for (const i of first.incomplete ?? []) if (i.suggestion) Object.assign(suggested, JSON.parse(`{${i.suggestion}}`));
  const full: Run = { ...legacy, lazy: false };
  const second = analyze(full, homeWith(serviceOf(legacy.project), suggested));
  report(describeRun(full, ', with the profile the first run suggested'), second, full);
  const left = (second.incomplete ?? []).map((i) => `${i.kind}: ${(i.items ?? []).join(' | ')}`);
  if (left.length) failures++;
  console.log(`  ${left.length ? '✖' : '✓'} [I6] with the suggested profile applied, nothing is incomplete${left.length ? `\n        got: ${left.join('; ')}` : ''}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} invariant(s) broken` : '\nall invariants hold on every review');
process.exit(failures ? 1 : 0);
