/**
 * Example data from the service's own tests, for services without a hand-written scenario (which is most of them).
 *
 * The specs that reference the changed classes and their callers are run with the service's Jest, under the same
 * kind of instrumentation the scenario runner uses: every module operation a test calls records its first input and
 * output, and every test is one case ("ManualReviewService › approve › approves the record"). The data comes from
 * the tests' mocks, and the review says so ("from unit tests (mocked dependencies)").
 *
 * Nothing in the service changes: Jest runs with a config written to a temporary folder that adds one setup file and
 * wraps the service's own transformer (ts-jest, babel-jest, …). Branches and PRs run in the temporary git worktree.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Example, ExampleCase, ModuleGraph } from '../../schema/modulegraph.ts';
import type { OperationTarget } from './analyzers/types.ts';
import { examplesFromCases } from './example-cases.ts';

const here = dirname(fileURLToPath(import.meta.url));

export interface TestExamplesResult {
  examples: Record<string, Example[]>;
  cases: ExampleCase[];
  /** Spec files that ran, relative to the project folder. */
  specs: string[];
  tests: number;
  timedOut: boolean;
  /** Why nothing was recorded, when nothing was. */
  note?: string;
  ms: number;
}

interface JestConfig {
  rootDir?: string;
  roots?: string[];
  testRegex?: string | string[];
  transform?: Record<string, string | [string, Record<string, unknown>]>;
  setupFilesAfterEnv?: string[];
  moduleDirectories?: string[];
  [key: string]: unknown;
}

/** The service's Jest config (package.json "jest", jest.config.json/js/cjs) and the folder it is relative to. */
export function jestConfigOf(projectDir: string): { config: JestConfig; dir: string; file: string } | undefined {
  const pkgFile = join(projectDir, 'package.json');
  if (existsSync(pkgFile)) {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { jest?: JestConfig };
    if (pkg.jest) return { config: pkg.jest, dir: projectDir, file: 'package.json' };
  }
  for (const name of ['jest.config.json', 'jest.config.js', 'jest.config.cjs']) {
    const file = join(projectDir, name);
    if (!existsSync(file)) continue;
    try {
      const config = name.endsWith('.json') ? (JSON.parse(readFileSync(file, 'utf8')) as JestConfig) : (createRequire(file)(file) as JestConfig);
      return { config: (config as { default?: JestConfig }).default ?? config, dir: projectDir, file: name };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Spec files under the config's roots (no e2e specs: those need the app's infrastructure). */
function specFiles(root: string, config: JestConfig): string[] {
  const regexes = (Array.isArray(config.testRegex) ? config.testRegex : config.testRegex ? [config.testRegex] : []).map((r) => new RegExp(r));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(name) && (!regexes.length || regexes.some((r) => r.test(path.replace(/\\/g, '/'))))) out.push(path);
    }
  };
  const roots = (config.roots ?? ['<rootDir>']).map((r) => r.replace('<rootDir>', root));
  for (const r of roots) if (existsSync(r)) walk(r);
  return out;
}

/**
 * Names that tie a spec to the change: the classes of the changed operations, of the operations that call them, and
 * the files of the entry points that call them (a controller's spec imports `./x.controller`).
 */
export function changeNames(g: Pick<ModuleGraph, 'operations' | 'modules' | 'scopes' | 'entryPoints' | 'review'>): { classes: string[]; stems: string[] } {
  const changed = new Set(g.review.queue.map((q) => q.operation));
  const classes = new Set<string>();
  const stems = new Set<string>();
  const stem = (file: string) => basename(file).replace(/\.[cm]?[jt]sx?$/, '');
  for (const id of changed) {
    const op = g.operations[id];
    if (!op) continue;
    classes.add(g.modules[op.moduleId]?.className ?? op.moduleId);
    stems.add(stem(op.file));
  }
  for (const [scopeId, scope] of Object.entries(g.scopes)) {
    if (!scope.steps.some((s) => s.target && changed.has(s.target))) continue;
    const op = g.operations[scopeId];
    const entry = g.entryPoints[scopeId];
    if (op) {
      classes.add(g.modules[op.moduleId]?.className ?? op.moduleId);
      stems.add(stem(op.file));
    } else if (entry) stems.add(stem(entry.file));
  }
  return { classes: [...classes], stems: [...stems] };
}

/** Specs that import or instantiate one of these classes, or import one of these files. */
export function selectSpecs(files: string[], names: { classes: string[]; stems: string[] }): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cls = names.classes.length ? new RegExp(`\\b(${names.classes.map(esc).join('|')})\\b`) : undefined;
  const imp = names.stems.length ? new RegExp(`from\\s+['"][^'"]*\\/(${names.stems.map(esc).join('|')})(\\.[cm]?[jt]sx?)?['"]`) : undefined;
  return files.filter((f) => {
    const text = readFileSync(f, 'utf8');
    return (!!cls && cls.test(text)) || (!!imp && imp.test(text));
  });
}

export interface TestRunInput {
  /** Where the service's code is (the working tree, or the head's temporary worktree). */
  projectRoot: string;
  /** The project folder in the real checkout: its node_modules, and where Jest is installed. */
  installedProject: string;
  targets: OperationTarget[];
  /** Absolute target files: they are in `codeRoot`. */
  codeRoot: string;
  names: { classes: string[]; stems: string[] };
  tmp: string;
  timeoutSeconds: number;
}

/** Runs the selected specs with the service's Jest and turns what the instrumented module calls did into examples. */
export function recordTestExamples(input: TestRunInput): TestExamplesResult {
  const started = Date.now();
  const none = (note: string): TestExamplesResult => ({ examples: {}, cases: [], specs: [], tests: 0, timedOut: false, note, ms: Date.now() - started });
  const found = jestConfigOf(input.projectRoot);
  if (!found) return none('no Jest config (package.json "jest" or jest.config.json/js) in the project');
  let jestBin: string;
  try {
    // Through its package.json: jest's `exports` hide `bin/jest.js` from a plain resolve.
    const req = createRequire(join(input.installedProject, 'package.json'));
    const pkgFile = req.resolve('jest/package.json');
    const bin = (JSON.parse(readFileSync(pkgFile, 'utf8')) as { bin?: string | Record<string, string> }).bin;
    jestBin = join(dirname(pkgFile), typeof bin === 'string' ? bin : bin?.jest ?? 'bin/jest.js');
  } catch {
    return none('Jest is not installed in the project (npm install)');
  }
  const rootDir = resolve(found.dir, found.config.rootDir ?? '.');
  const specs = selectSpecs(specFiles(rootDir, found.config), input.names);
  if (!specs.length) return none(`no spec file references ${[...input.names.classes].slice(0, 4).join(', ') || 'the changed code'}`);

  const out = join(input.tmp, 'test-examples');
  mkdirSync(out, { recursive: true });
  const targetsFile = join(input.tmp, 'test-targets.json');
  writeFileSync(targetsFile, JSON.stringify(input.targets.map((t) => ({ ...t, file: join(input.codeRoot, t.file).replace(/\\/g, '/') }))));
  const transform = Object.fromEntries(
    Object.entries(found.config.transform ?? { '^.+\\.[jt]sx?$': 'babel-jest' }).map(([pattern, inner]): [string, [string, Record<string, unknown>]] => [pattern, [join(here, 'test-examples/transformer.cjs'), { inner, from: input.installedProject, targets: targetsFile }]]),
  );
  // In a worktree the service's own node_modules are not above the code: look there first.
  const installedModules = join(input.installedProject, 'node_modules');
  const config: JestConfig = {
    ...found.config,
    rootDir,
    transform,
    setupFilesAfterEnv: [...(found.config.setupFilesAfterEnv ?? []), join(here, 'test-examples/setup.cjs')],
    ...(resolve(input.projectRoot) !== resolve(input.installedProject) && existsSync(installedModules) ? { moduleDirectories: [installedModules, ...(found.config.moduleDirectories ?? ['node_modules'])] } : {}),
    collectCoverage: false,
  };
  const configFile = join(input.tmp, 'jest.config.json');
  writeFileSync(configFile, JSON.stringify(config));
  const run = spawnSync(process.execPath, [jestBin, '--config', configFile, '--runTestsByPath', ...specs, '--ci', '--silent', '--colors=false', '--watchman=false', '--passWithNoTests', '--maxWorkers=50%'], {
    cwd: input.projectRoot,
    env: { ...process.env, MODULEGRAPH_EXAMPLES_DIR: out, NODE_ENV: process.env.NODE_ENV ?? 'test' },
    encoding: 'utf8',
    timeout: input.timeoutSeconds * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = !!run.error && /ETIMEDOUT|timed out/i.test(String(run.error)) || run.signal === 'SIGTERM';
  const summary = `${run.stderr ?? ''}`.split('\n').filter((l) => /^(Tests|Test Suites):/.test(l.trim())).map((l) => l.trim()).join('; ');
  if (summary) console.log(`examples: jest ${summary}`);

  const cases: { id: string; label: string; calls: Record<string, Example> }[] = [];
  let tests = 0;
  const ran: string[] = [];
  for (const name of existsSync(out) ? readdirSync(out).sort() : []) {
    const file = JSON.parse(readFileSync(join(out, name), 'utf8')) as { testPath: string; tests: number; cases: { label: string; calls: Record<string, Example> }[] };
    const spec = relative(input.projectRoot, file.testPath).replace(/\\/g, '/');
    ran.push(spec);
    tests += file.tests;
    for (const c of file.cases) cases.push({ id: `t${cases.length + 1}`, label: `${basename(spec)} › ${c.label}`, calls: c.calls });
  }
  const { examples, cases: used } = examplesFromCases(cases);
  return {
    examples,
    cases: used,
    specs: ran.length ? ran : specs.map((s) => relative(input.projectRoot, s).replace(/\\/g, '/')),
    tests,
    timedOut,
    ...(!used.length ? { note: timedOut ? `the tests did not finish within ${input.timeoutSeconds} s` : run.status !== 0 && !ran.length ? `jest failed: ${(run.stderr || String(run.error ?? '')).trim().split('\n').slice(-3).join(' ').slice(0, 300)}` : 'the selected tests call no module operation for real (everything is mocked)' } : {}),
    ms: Date.now() - started,
  };
}
