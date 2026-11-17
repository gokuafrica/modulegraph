/**
 * Checks that reviews end: servers stop by themselves when idle and when the process that started them dies, and
 * `modulegraph done` / `clean` remove a review's files, PR ref and scenario leftovers, and nothing else in the
 * reviewed repo. Everything runs against a throwaway git repo and a throwaway MODULEGRAPH_HOME.
 * usage: npx tsx src/lifecycle-check.ts (part of npm test)
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'modulegraph-lifecycle-')));
const home = join(scratch, 'home');
const repo = join(scratch, 'tiny-service').replace(/\\/g, '/');
const reviews = join(home, 'reviews');
// Before anything reads home.ts: every path of this check is inside the scratch folder.
process.env.MODULEGRAPH_HOME = home;
const env = { ...process.env, MODULEGRAPH_HOME: home };

let failures = 0;
const expect = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✖'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tsx = ['--import', 'tsx'];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const until = async (cond: () => boolean | Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(150);
  }
  return cond();
};
const servers = () => (existsSync(join(home, 'servers')) ? readdirSync(join(home, 'servers')).map((f) => JSON.parse(readFileSync(join(home, 'servers', f), 'utf8')) as { pid: number; port: number; ids: string[] }) : []);
const serverOf = (id: string) => servers().find((s) => s.ids.includes(id));
const end = (...args: string[]) => spawnSync(process.execPath, [...tsx, join(here, 'end.ts'), ...args], { cwd: resolve(here, '..'), env, encoding: 'utf8' });

// ---------- a throwaway service with one change ----------
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'tiny-service', version: '1.0.0', private: true }));
writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true }, include: ['src'] }));
writeFileSync(join(repo, 'src/store.ts'), 'export class Store {\n  private rows: string[] = [];\n  save(row: string): void {\n    this.rows.push(row);\n  }\n}\n');
writeFileSync(join(repo, 'src/service.ts'), "import { Store } from './store';\n\nexport class Service {\n  constructor(private store: Store) {}\n  handle(name: string): string {\n    return name.trim();\n  }\n}\n");
g('init', '-q', '-b', 'main');
g('-c', 'user.name=check', '-c', 'user.email=check@example.invalid', 'add', '.');
g('-c', 'user.name=check', '-c', 'user.email=check@example.invalid', 'commit', '-q', '-m', 'tiny service');
g('checkout', '-q', '-b', 'feature/save');
writeFileSync(join(repo, 'src/service.ts'), "import { Store } from './store';\n\nexport class Service {\n  constructor(private store: Store) {}\n  handle(name: string): string {\n    this.store.save(name);\n    return name.trim();\n  }\n}\n");
g('-c', 'user.name=check', '-c', 'user.email=check@example.invalid', 'commit', '-q', '-am', 'save every name');
g('checkout', '-q', 'main');

/** A served review of the change (cli.ts directly, or through the launcher). */
function serveReview(id: string, extra: string[], viaLauncher = false): { child: ChildProcess; out: () => string } {
  const args = ['--project', repo, '--head', 'feature/save', '--base', 'main', '--name', id, '--port', '0', ...extra];
  const child = viaLauncher
    ? spawn(process.execPath, [join(root, 'bin/modulegraph.mjs'), 'review', '--no-open', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, [...tsx, join(here, 'cli.ts'), '--lazy', '--serve', ...args], { cwd: resolve(here, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout!.on('data', (d) => (text += d));
  child.stderr!.on('data', (d) => (text += d));
  return { child, out: () => text };
}
// 'close', not 'exit': output can still be arriving through the pipes after the process exits.
const exited = (c: ChildProcess) => new Promise<number | null>((r) => (c.exitCode !== null && c.stdout!.closed ? r(c.exitCode) : c.on('close', (code) => r(code))));

try {
  console.log('idle shutdown');
  {
    const s = serveReview('idle-test', ['--idle', '0.04']);
    const up = await until(() => !!serverOf('idle-test'), 60_000);
    expect('the server registers itself while it runs', up, s.out());
    // The registry file can appear before the startup line has come through the pipe: wait for the line itself.
    expect('its startup line says when it stops', await until(() => /stops after 2 s with no requests/.test(s.out()), 10_000), s.out());
    const code = await Promise.race([exited(s.child), sleep(20_000).then(() => 'timeout' as const)]);
    expect('with no requests it stops by itself, exit 0', code === 0, `exit ${code}\n${s.out()}`);
    expect('and says why', /stopped: no requests for 2 s/.test(s.out()), s.out());
    expect('and its registry entry is gone', !serverOf('idle-test'));
  }

  console.log('\nrequests keep it running; done ends it');
  {
    const s = serveReview('busy-test', ['--idle', '0.05']);
    await until(() => !!serverOf('busy-test'), 60_000);
    const { port, pid } = serverOf('busy-test')!;
    const base = `http://127.0.0.1:${port}/api`;
    for (let i = 0; i < 8; i++) {
      await fetch(`${base}/graphs/busy-test/status`);
      await sleep(1000);
    }
    expect('a status request every second keeps it running past its 3 s idle limit', alive(pid) && s.child.exitCode === null);
    const noHeader = await fetch(`${base}/graphs/busy-test/done`, { method: 'POST', body: '{}' });
    const noHeaderStop = await fetch(`${base}/shutdown`, { method: 'POST' });
    expect('done and shutdown without the x-modulegraph header are refused (a web page cannot end a review)', noHeader.status === 403 && noHeaderStop.status === 403 && alive(pid));
    expect('the review files exist before done', existsSync(join(reviews, 'busy-test.json')) && existsSync(join(reviews, 'busy-test.brief.md')));
    const r = end('done', 'busy-test');
    console.log(r.stdout.trim().split('\n').map((l) => `      | ${l}`).join('\n'));
    expect('modulegraph done exits 0', r.status === 0, r.stderr);
    expect('it stopped the server', await until(() => !alive(pid), 10_000));
    expect('and removed the graph, the brief and the index entry',
      !existsSync(join(reviews, 'busy-test.json')) && !existsSync(join(reviews, 'busy-test.brief.md'))
      && !(JSON.parse(readFileSync(join(reviews, 'index.json'), 'utf8')) as { id: string }[]).some((e) => e.id === 'busy-test'));
  }

  console.log('\na server dies with the process that started it (hard kill)');
  {
    const s = serveReview('orphan-test', ['--idle', '0'], true);
    const up = await until(() => !!serverOf('orphan-test'), 60_000);
    const pid = serverOf('orphan-test')?.pid ?? -1;
    expect('the launcher started a server in a child process', up && pid !== s.child.pid, s.out());
    s.child.kill('SIGKILL');
    expect('killing the launcher hard stops the server too (even with --idle 0)', await until(() => !alive(pid), 15_000), s.out());
  }

  console.log('\nclean and done remove modulegraph leftovers, and nothing else');
  {
    const day = 86_400_000;
    const head = g('rev-parse', 'feature/save');
    const review = (id: string, pr: number, ageDays: number) => {
      writeFileSync(join(reviews, `${id}.json`), JSON.stringify({ schema: 'modulegraph/v1', source: { mode: 'pr', repo, project: '.', head: `#${pr}`, files: [] } }));
      writeFileSync(join(reviews, `${id}.brief.md`), `# ${id}\n`);
      const index = JSON.parse(readFileSync(join(reviews, 'index.json'), 'utf8')) as unknown[];
      writeFileSync(join(reviews, 'index.json'), JSON.stringify([{ id, title: id, mode: 'pr', generatedAt: new Date(Date.now() - ageDays * day).toISOString() }, ...index]));
    };
    review('pr-7-old', 7, 30);
    review('pr-8-recent', 8, 1);
    review('pr-6-keep-brief', 6, 1);
    for (const n of [6, 7, 8, 9]) g('update-ref', `refs/modulegraph/pr-${n}`, head);
    g('branch', 'keep-me', head);
    // Scenario leftovers: a killed run (folder + worktree), a killed run whose folder was deleted by hand, a running one.
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    const dead2 = spawnSync(process.execPath, ['-e', '']).pid!;
    g('worktree', 'add', '-q', '--detach', `.modulegraph-tmp/${dead}/wt-a`, head);
    g('worktree', 'add', '-q', '--detach', `.modulegraph-tmp/${dead2}/wt-b`, head);
    rmSync(join(repo, `.modulegraph-tmp/${dead2}`), { recursive: true, force: true });
    mkdirSync(join(repo, `.modulegraph-tmp/${process.pid}`), { recursive: true });
    writeFileSync(join(repo, '.modulegraph-tmp/someones-output.json'), '{}');
    // The user's own things: an uncommitted file, and a worktree of theirs whose folder is missing (prunable).
    writeFileSync(join(repo, 'notes.txt'), 'mine\n');
    g('worktree', 'add', '-q', '--detach', join(scratch, 'users-worktree'), head);
    rmSync(join(scratch, 'users-worktree'), { recursive: true, force: true });
    const refs = () => g('for-each-ref', '--format=%(refname)').split('\n');
    const worktrees = () => g('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
    const before = { refs: refs(), worktrees: worktrees() };

    const dry = end('clean', '--dry-run');
    console.log(dry.stdout.trim().split('\n').map((l) => `      | ${l}`).join('\n'));
    expect('clean --dry-run lists what it would remove and removes nothing',
      /would remove .*pr-7-old\.json/.test(dry.stdout) && /would remove refs\/modulegraph\/pr-9/.test(dry.stdout)
      && JSON.stringify(refs()) === JSON.stringify(before.refs) && JSON.stringify(worktrees()) === JSON.stringify(before.worktrees) && existsSync(join(reviews, 'pr-7-old.json')));

    const c = end('clean');
    console.log(c.stdout.trim().split('\n').map((l) => `      | ${l}`).join('\n'));
    const r = refs();
    expect('clean removes the review older than 14 days', !existsSync(join(reviews, 'pr-7-old.json')) && !existsSync(join(reviews, 'pr-7-old.brief.md')));
    expect('keeps the recent ones', existsSync(join(reviews, 'pr-8-recent.json')) && existsSync(join(reviews, 'pr-6-keep-brief.json')));
    expect('removes the PR refs no remaining review uses (7, 9), keeps those in use (6, 8)',
      !r.includes('refs/modulegraph/pr-7') && !r.includes('refs/modulegraph/pr-9') && r.includes('refs/modulegraph/pr-8') && r.includes('refs/modulegraph/pr-6'), r.join(' '));
    const wts = worktrees();
    expect('removes the worktrees of killed runs, also the one whose folder was deleted by hand',
      !wts.some((w) => w.includes(`.modulegraph-tmp/${dead}/`)) && !wts.some((w) => w.includes(`.modulegraph-tmp/${dead2}/`)) && !existsSync(join(repo, `.modulegraph-tmp/${dead}`)), wts.join('\n'));
    expect('keeps the temp folder of a run that is still going', existsSync(join(repo, `.modulegraph-tmp/${process.pid}`)));
    expect('keeps anything in .modulegraph-tmp that is not a <pid> folder (output someone wrote there)', readFileSync(join(repo, '.modulegraph-tmp/someones-output.json'), 'utf8') === '{}');
    const outside = c.stdout.split('\n').filter((l) => l.startsWith('removed ') && !l.startsWith('removed index entry ') && !l.includes(scratch.replace(/\\/g, '/')));
    expect('touches nothing outside the repos and home it was given', outside.length === 0, outside.join('\n'));
    expect("leaves the user's own prunable worktree, branch and uncommitted file alone",
      wts.some((w) => w.includes('users-worktree')) && r.includes('refs/heads/keep-me') && readFileSync(join(repo, 'notes.txt'), 'utf8') === 'mine\n');
    expect('leaves the tracked code alone', g('status', '--porcelain', '--', 'src') === '' && g('rev-parse', 'feature/save') === head);

    const d = end('done', 'pr-8-recent');
    console.log(d.stdout.trim().split('\n').map((l) => `      | ${l}`).join('\n'));
    expect('done <id> of a review nobody serves removes its files and its PR ref',
      d.status === 0 && !existsSync(join(reviews, 'pr-8-recent.json')) && !existsSync(join(reviews, 'pr-8-recent.brief.md')) && !refs().includes('refs/modulegraph/pr-8'));
    const k = end('done', 'pr-6-keep-brief', '--keep-brief');
    expect('done --keep-brief keeps only the brief', k.status === 0 && !existsSync(join(reviews, 'pr-6-keep-brief.json')) && existsSync(join(reviews, 'pr-6-keep-brief.brief.md')) && !refs().includes('refs/modulegraph/pr-6'));
    const bad = end('done', '../index');
    expect('done refuses ids that are paths', bad.status === 2 && existsSync(join(reviews, 'index.json')));
    const none = end('done');
    expect('done without an id and nothing served asks which one (exit 2)', none.status === 2 && /name the one you are done with/.test(none.stdout), none.stdout);
    rmSync(join(repo, `.modulegraph-tmp/${process.pid}`), { recursive: true, force: true });
  }
} finally {
  for (const s of servers()) {
    try {
      process.kill(s.pid);
    } catch {
      // already gone
    }
  }
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repo, stdio: 'ignore' });
  } catch {
    // the scratch repo goes anyway
  }
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failure(s)` : '\nreviews end: idle servers stop, done and clean remove only what modulegraph left');
process.exit(failures ? 1 : 0);
