/**
 * The review UI in a real (headless) browser, as a reviewer uses it, on the realistic sample
 * (sample-legacy-nest-service, branch fix/scope-manual-data-to-row, no profile):
 *   - `analyze` then `open <id>`: the review is live (● live, ↻ refresh, ✓ done) and the top bar fits on one line;
 *   - impact view: the Kafka handler that calls the change counts its side effects ("3 side effects, none changed");
 *   - flow of PUT …/approve/:guid: the business module, and the request pipeline as one folded node;
 *   - inspector on the changed operation: description from @ApiOperation, examples from unit tests, one risk wording,
 *     long helper names readable with their file and +/- counts visible;
 *   - drill-in: now | before, code changes ± (2), the new db.read marked as added;
 *   - the server stops: the page says it is a saved file and what to run; `open --static` after a reload says why;
 *   - refresh: edit the code of a checked-out branch, the refresh button notices, a click re-analyzes.
 * Uses the installed Edge or Chrome (playwright-core, no download); skips when there is none.
 * usage: npm run ui-check --workspace analyzer [-- --shots <dir>]
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright-core';
import { git } from './git.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..').replace(/\\/g, '/');
const bin = join(repo, 'bin/modulegraph.mjs');
const { values: opts } = parseArgs({ options: { shots: { type: 'string' } } });
const home = mkdtempSync(join(tmpdir(), 'mg-ui-'));
const env = { ...process.env, MODULEGRAPH_HOME: home };
const PORT = 5191;
const id = 'branch-fix-scope-manual-data-to-row';
let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  ✖ ${msg}`);
};
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const children: ChildProcess[] = [];
/** The refresh check makes .worktrees/ when there is none; it removes it again then. */
const hadWorktrees = existsSync(join(repo, '.worktrees'));

async function launch(): Promise<Browser | undefined> {
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // not installed
    }
  }
  return undefined;
}

function start(args: string[], cwd = repo): ChildProcess {
  const child = spawn(process.execPath, [bin, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', () => undefined);
  child.stderr!.on('data', () => undefined);
  children.push(child);
  return child;
}

async function waitFor(fn: () => Promise<boolean> | boolean, what: string, ms = 120_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if (await fn()) return true;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  fail(`timed out waiting for ${what}`);
  return false;
}

const health = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { graphs: string[] };
const stop = (port: number) => fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { 'x-modulegraph': 'stop' } }).catch(() => undefined);
let shotN = 0;
async function shot(page: Page, name: string): Promise<void> {
  if (!opts.shots) return;
  mkdirSync(opts.shots, { recursive: true });
  const vp = page.viewportSize();
  await page.screenshot({ path: join(opts.shots, `${String(++shotN).padStart(2, '0')}-${name}-${vp?.width}x${vp?.height}.png`) });
}

async function go(page: Page, port: number, hash: string): Promise<void> {
  // A new query string reloads the page: a hash change alone would keep the old state.
  await page.goto(`http://127.0.0.1:${port}/?r=${Date.now()}#g=${id}${hash ? `&${hash}` : ''}`);
  await page.waitForSelector('.react-flow__node', { timeout: 60_000 });
  await page.waitForTimeout(1200);
}

const nodeText = (page: Page, contains: string) => page.evaluate((t) => [...document.querySelectorAll('.react-flow__node')].map((n) => n.textContent ?? '').find((x) => x.includes(t)) ?? '', contains);

async function main(): Promise<void> {
  const browser = await launch();
  if (!browser) {
    console.log('ui-check skipped: no Edge or Chrome installed (playwright-core uses the installed browser)');
    return;
  }
  try {
    console.log('\nanalyze, then open (no profile)');
    execFileSync(process.execPath, [bin, 'analyze', '--project', 'sample-legacy-nest-service', '--head', 'fix/scope-manual-data-to-row', '--lazy'], { cwd: repo, env, stdio: 'ignore' });
    start(['open', id, '--no-open', '--port', String(PORT), '--idle', '5']);
    if (!(await waitFor(async () => (await health(PORT)).graphs.includes(id), 'the live server of `open`'))) return;
    ok('`modulegraph open <id>` serves the saved review live');

    for (const [w, h] of [[1440, 900], [1920, 1080]] as const) {
      console.log(`\n${w}×${h}`);
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await go(page, PORT, `v=impact&op=${encodeURIComponent('ManualReviewService.updateUserRecordData')}&d=1`);
      await page.waitForSelector('.lazy-badge.live', { timeout: 30_000 });
      const bar = await page.evaluate(() => {
        const top = document.querySelector('.topbar')!;
        const text = top.textContent ?? '';
        const labels = [...top.querySelectorAll(':scope > label')].map((l) => l.getBoundingClientRect());
        return { text, labelHeights: labels.map((r) => Math.round(r.height)), labelTops: labels.map((r) => Math.round(r.top)), barHeight: Math.round(top.getBoundingClientRect().height) };
      });
      for (const t of ['● live', '↻ refresh', '✓ done']) if (!bar.text.includes(t)) fail(`top bar has no "${t}"`);
      if (bar.labelHeights.some((x) => x > 24) || new Set(bar.labelTops).size > 1) fail(`toggles wrap: heights ${bar.labelHeights.join(', ')}, tops ${bar.labelTops.join(', ')}`);
      else ok('top bar: ● live, ↻ refresh, ✓ done, toggles on one line');
      const handler = await nodeText(page, 'UserRecordDataUpdatedHandler');
      if (!/[1-9]\d* side effects?, none changed/.test(handler)) fail(`impact: the handler node says "${handler.slice(0, 120)}"`);
      else ok(`impact: ${/(\d+ side effects?, none changed)/.exec(handler)![1]} on the Kafka handler`);
      await shot(page, 'impact-update-d1');
      await go(page, PORT, `v=impact&op=${encodeURIComponent('ManualReviewService.approve')}&d=2`);
      await shot(page, 'impact-approve-d2');

      await go(page, PORT, `v=flow&t=${encodeURIComponent('api:PUT /api/v1/internal/manual-review/approve/:guid')}`);
      const flow = await page.evaluate(() => ({
        pipeline: document.querySelectorAll('.node.pipeline').length,
        modules: [...document.querySelectorAll('.node.module .module-title')].map((n) => n.textContent),
      }));
      if (flow.pipeline !== 1 || flow.modules.some((m) => /Metrics/.test(m ?? ''))) fail(`flow: ${flow.pipeline} pipeline nodes, modules ${flow.modules.join(', ')}`);
      else ok(`flow: ${flow.modules.join(', ')} + one folded request pipeline node`);
      await shot(page, 'flow-approve');

      await page.evaluate(() => ([...document.querySelectorAll('.react-flow__node')].find((n) => n.textContent?.includes('.approve()')) as HTMLElement | undefined)?.click());
      await page.waitForSelector('.inspector', { timeout: 10_000 });
      await page.waitForTimeout(500);
      const insp = await page.evaluate(() => {
        const panel = document.querySelector('.inspector')!;
        const right = panel.getBoundingClientRect().right;
        const rows = [...panel.querySelectorAll('.fn-row')].map((r) => {
          const counts = r.querySelector('.counts')!.getBoundingClientRect();
          const file = r.querySelector('.fn-file')!.getBoundingClientRect();
          return { text: r.textContent, countsVisible: counts.right <= right + 1 && counts.width > 0, fileVisible: file.width > 10 && file.right <= right + 1 };
        });
        return { text: panel.textContent ?? '', rows };
      });
      for (const t of ['change: medium', 'contract: low', 'from @ApiOperation', 'from unit tests (mocked dependencies)']) if (!insp.text.includes(t)) fail(`inspector has no "${t}"`);
      if (/\bLOW RISK\b|low risk/.test(insp.text)) fail('inspector still says "low risk"');
      if (!insp.rows.length || insp.rows.some((r) => !r.countsVisible || !r.fileVisible)) fail(`code-change rows cut off: ${JSON.stringify(insp.rows)}`);
      if (!failures) ok('inspector: @ApiOperation description, examples from tests, "change: medium" + "contract: low", readable rows');
      await shot(page, 'inspector-approve');

      await go(page, PORT, `v=flow&t=${encodeURIComponent('api:PUT /api/v1/internal/manual-review/approve/:guid')}|${encodeURIComponent('ManualReviewService.approve')}`);
      const drill = await page.evaluate(() => ({
        seg: !!document.querySelector('.seg'),
        diff: document.querySelector('.diff-crumb')?.textContent ?? '',
        added: [...document.querySelectorAll('.react-flow__node .step-added')].map((n) => n.textContent ?? ''),
      }));
      if (!drill.seg || !/code changes ± \(2\)/.test(drill.diff) || !drill.added.some((t) => /user_records/.test(t))) fail(`drill-in: ${JSON.stringify(drill)}`);
      else ok('drill-in: now | before, code changes ± (2), the new db.read user_records marked as added');
      await shot(page, 'drill-approve');
      if (w !== 1920) await page.close();
      else {
        // Stop the server while the page is open: it says it is a saved file, and what to run.
        await stop(PORT);
        if (await waitFor(async () => (await page.textContent('.topbar'))?.includes(`○ saved: run modulegraph open ${id} to refresh`) ?? false, 'the saved-mode message after the server stopped', 30_000)) ok('server stopped: "○ saved: run modulegraph open <id> to refresh"');
        await shot(page, 'saved-after-stop');
        await page.close();
      }
    }

    console.log('\nopen --static, reload');
    await waitFor(async () => !(await health(PORT).catch(() => undefined)), 'the live server to stop', 15_000);
    start(['open', id, '--static', '--no-open', '--port', String(PORT), '--idle', '5']);
    await waitFor(async () => !!(await health(PORT)), 'the static server');
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await go(page, PORT, '');
    if (await waitFor(async () => /○ saved: opened with --static: run modulegraph open/.test((await page.textContent('.topbar')) ?? ''), 'the saved-mode reason', 15_000)) ok('reloaded on a static server: "○ saved: opened with --static: run modulegraph open <id> to refresh", no refresh or done');
    if (await page.$('button.refresh')) fail('refresh / done buttons shown on a saved file');
    await shot(page, 'saved-static');
    await page.close();
    await stop(PORT);

    await refreshCheck(browser);
  } finally {
    await browser.close();
  }
}

/** A branch checked out (a throwaway worktree): edit its code, the page notices, refresh re-analyzes. */
async function refreshCheck(browser: Browser): Promise<void> {
  console.log('\nrefresh after an edit in the working tree');
  const branch = 'tmp/mg-ui-check';
  const wt = join(repo, '.worktrees', 'mg-ui-check').replace(/\\/g, '/');
  try {
    git(repo, ['branch', '-f', branch, 'fix/scope-manual-data-to-row']);
    git(repo, ['worktree', 'add', wt, branch]);
    const port = PORT + 1;
    start(['review', '--project', join(wt, 'sample-legacy-nest-service'), '--base', 'main', '--no-open', '--no-tests', '--port', String(port), '--idle', '5', '--name', id]);
    if (!(await waitFor(async () => (await health(port)).graphs.includes(id), 'the review server on the worktree'))) return;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/?r=1#g=${id}`);
    await page.waitForSelector('.lazy-badge.live', { timeout: 60_000 });
    const file = join(wt, 'sample-legacy-nest-service/src/manual-review/services/manual-review.service.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace('const merged = { ...row.data, ...agentData };', 'const merged = { ...row.data, ...this.userRecordDataTransformer.normalize(agentData) };'));
    if (!(await waitFor(async () => (await page.textContent('button.refresh'))?.includes('code changed: refresh') ?? false, 'the refresh prompt', 30_000))) return;
    ok('the edit is noticed: "↻ code changed: refresh"');
    await shot(page, 'refresh-prompt');
    await page.click('button.refresh');
    if (await waitFor(async () => /Re-analyzed in .*manual-review\.service\.ts changed/.test((await page.textContent('.toast').catch(() => '')) ?? ''), 'the re-analysis', 60_000)) ok('refresh re-analyzed the edited file');
    await page.close();
    await stop(port);
    await waitFor(async () => !(await health(port).catch(() => undefined)), 'the review server to stop', 15_000);
  } finally {
    try {
      git(repo, ['worktree', 'remove', '--force', wt]);
    } catch {
      // not created
    }
    try {
      git(repo, ['branch', '-D', branch]);
    } catch {
      // not created
    }
  }
}

try {
  await main();
} catch (err) {
  fail(String(err));
} finally {
  for (const c of children) if (c.exitCode === null) c.kill();
  rmSync(home, { recursive: true, force: true });
  if (existsSync(join(repo, '.worktrees')) && !git(repo, ['worktree', 'list']).includes('.worktrees/mg-ui-check')) {
    try {
      rmSync(join(repo, '.worktrees', 'mg-ui-check'), { recursive: true, force: true });
      // The folder itself only when this check made it (rmdir removes an empty folder only).
      if (!hadWorktrees) rmdirSync(join(repo, '.worktrees'));
    } catch {
      // in use, or someone else's worktrees are there
    }
  }
}
console.log(failures ? `\n${failures} UI problem(s)` : '\nthe review UI works as a reviewer uses it');
process.exit(failures ? 1 : 0);
