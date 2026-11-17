#!/usr/bin/env node
/**
 * Round-2 acceptance check for modulegraph, run on the fixture made by create-r2-fixture.mjs.
 *
 *   node accept-r2.mjs --modulegraph <modulegraph checkout> --fixture <fixture dir> [--ui] [--fresh-clone <git url>]
 *
 * Every expectation here was written from the fixture's source, by hand, before any modulegraph output was looked
 * at: 29 handler-map entries, 7 jobs, 3 resolvable Kafka topics, 1 outbox event type. DO NOT EDIT the expectations or
 * the fixture to make a check pass. If you believe an expectation is wrong, say which and why in your report and
 * leave it failing.
 *
 * Exit 0 only when every check passes. --ui needs an installed Edge or Chrome (playwright-core from the modulegraph
 * checkout); without one the UI checks FAIL, they are not skipped.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({ options: { modulegraph: { type: 'string' }, fixture: { type: 'string' }, ui: { type: 'boolean' }, 'fresh-clone': { type: 'string' }, keep: { type: 'boolean' } } });
if (!opt.modulegraph || !opt.fixture) {
  console.error('usage: node accept-r2.mjs --modulegraph <dir> --fixture <dir> [--ui] [--fresh-clone <git url>]');
  process.exit(2);
}
const mg = resolve(opt.modulegraph);
const fx = resolve(opt.fixture);
const bin = join(mg, 'bin/modulegraph.mjs');
const BRANCH = 'fix/conclude-review-row-scope';
const ID = 'branch-fix-conclude-review-row-scope';

const CONSUMER_KEYS = [
  'user-record-created', 'user-record-data-updated', 'user-record-deleted', 'document-uploaded', 'document-expired',
  'document-rejected', 'address-changed', 'name-changed', 'nationality-changed', 'birth-date-corrected',
  'tax-residency-updated', 'risk-score-updated', 'screening-hit-found', 'screening-hit-cleared', 'account-frozen',
  'account-unfrozen', 'email-verified', 'phone-verified', 'consent-given', 'consent-withdrawn', 'comment-added',
  'review-escalated', 'review-assigned', 'review-decision-requested', 'sync-feature-area-documents',
  'sync-feature-area-payments', 'sync-feature-area-notifications', 'sync-feature-area-reports', 'sync-feature-area-exports',
];
const SYNC_KEYS = CONSUMER_KEYS.filter((k) => k.startsWith('sync-feature-area-'));
const JOBS = ['stale-review-concluder', 'record-status-backfill', 'duplicate-scan', 'document-expiry-check', 'audit-export', 'feature-area-resync', 'outbox-cleanup'];
/** Entry points that reach the changed code (ConcludeManualReviewDecisionService.approve / setUserRecordManualReviewData). */
const MUST_REACH = ['kafka consumer review-decision-requested', ...SYNC_KEYS.map((k) => `kafka consumer ${k}`), 'job stale-review-concluder', 'job feature-area-resync'];
const TOPICS = { 'RecordEventsProducer.publishDuplicateFound': 'KAFKA_TOPICS.RECORD_DUPLICATE_FOUND', 'RecordEventsProducer.publishReviewConcluded': 'KAFKA_TOPICS.REVIEW_CONCLUDED' };
const OUTBOX = { 'NotificationsOutboxService.notifyReviewConcluded': 'ReviewConcludedNotification' };
const PROFILE = {
  service: 'records-review-service',
  entryRegistries: [
    { map: 'ConsumerHandlerMap', method: 'handleMessages', kind: 'consumer', label: 'kafka consumer {key}' },
    { argv: 'src/main.ts', kind: 'cron', label: 'job {key}' },
  ],
  sinks: [
    { class: 'AvroProducer', module: '@acme/nestjs-kafkajs', method: 'send', kind: 'kafka', target: 'arg:0.topic' },
    { class: 'TypeORMOutboxService', module: '@acme/typeorm-outbox-writer', method: 'createOutboxMessage', kind: 'outbox', target: 'arg:0' },
  ],
};

const results = [];
const check = (id, what, pass, detail = '') => {
  results.push({ id, what, pass });
  console.log(`  ${pass ? '✓' : '✖'} [${id}] ${what}${!pass && detail ? `\n        got: ${detail}` : ''}`);
};
const note = (id, what) => console.log(`  · [${id}] ${what}`);
const work = mkdtempSync(join(tmpdir(), 'mg-accept-r2-'));

function home(name, profile) {
  const h = join(work, name);
  mkdirSync(h, { recursive: true });
  if (profile) {
    mkdirSync(join(h, 'configs', PROFILE.service), { recursive: true });
    writeFileSync(join(h, 'configs', PROFILE.service, 'modulegraph.config.json'), JSON.stringify(PROFILE, null, 2));
  }
  return h;
}
function analyze(h, args) {
  const r = spawnSync(process.execPath, [bin, 'analyze', '--project', fx, ...args], { cwd: fx, env: { ...process.env, MODULEGRAPH_HOME: h }, encoding: 'utf8', timeout: 600_000 });
  const dir = join(h, 'reviews');
  const file = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.json') && !f.startsWith('index')) : undefined;
  if (!file) {
    console.log(r.stdout, r.stderr);
    throw new Error(`analyze ${args.join(' ')} wrote no review in ${dir}`);
  }
  const g = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const briefFile = join(dir, file.replace(/\.json$/, '.brief.md'));
  return { g, brief: existsSync(briefFile) ? readFileSync(briefFile, 'utf8') : '', id: file.replace(/\.json$/, ''), stdout: r.stdout };
}
const entries = (g, kind) => Object.values(g.entryPoints).filter((e) => !kind || e.kind === kind);
const suggestion = (g, kind) => (g.incomplete ?? []).filter((i) => i.kind === kind).map((i) => i.suggestion ?? '').join('\n');
const itemsText = (g) => (g.incomplete ?? []).flatMap((i) => [i.message, ...(i.items ?? []), i.suggestion ?? '']).join('\n');
/** Effects of one operation: its own, and those of its steps. */
function effectsOf(g, opId) {
  const op = g.operations[opId];
  const fx = [...(op?.effects ?? [])];
  for (const s of g.scopes[opId]?.steps ?? []) if (s.effect) fx.push(s.effect);
  return fx;
}
const allEffects = (g) => [...Object.values(g.operations).flatMap((o) => o.effects ?? []), ...Object.values(g.entryPoints).flatMap((e) => e.effects ?? [])];
const RAW = /[<>()`]|\bthis\.|\bparameters\.|configService/;

// ── 0. The fixture is what it claims to be ───────────────────────────────────────────────────────────────────
console.log('\n0. fixture');
check('setup', 'fixture is outside the modulegraph checkout', (() => { const r = relative(mg, fx); return r.startsWith('..') || isAbsolute(r); })(), fx);
const ver = (p) => { try { return JSON.parse(readFileSync(join(fx, p, 'package.json'), 'utf8')).version; } catch { return 'missing'; } };
const top = ver('node_modules/lru-cache');
const nested = ['node_modules/path-scurry/node_modules/lru-cache', 'node_modules/typeorm/node_modules/lru-cache'].map(ver).find((v) => v !== 'missing') ?? 'missing';
check('setup', `own node_modules: top-level lru-cache 5.x (got ${top}), nested lru-cache 10.x under path-scurry/typeorm (got ${nested})`, top.startsWith('5.') && nested.startsWith('10.'));
const branchNow = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: fx, encoding: 'utf8' }).trim();
check('setup', `branch ${BRANCH} checked out`, branchNow === BRANCH, branchNow);
const jest = spawnSync('npx jest --ci', { cwd: fx, shell: true, encoding: 'utf8' });
const jestTests = /Tests:\s+(\d+) passed/.exec(jest.stderr + jest.stdout)?.[1];
check('setup', `the fixture's own \`npx jest\` passes (10 tests)`, jest.status === 0 && jestTests === '10', `exit ${jest.status}, ${jestTests} passed`);

try {
  // ── 1. First run, no profile, lazy, --head (as the module-review skill runs it) ───────────────────────────
  console.log('\n1. no profile, --head, lazy');
  const hA = home('a-noprofile');
  const A = analyze(hA, ['--head', BRANCH, '--lazy']);
  const ex = A.g.source.examples ?? {};
  const conclude = (ex.cases ?? []).filter((c) => /conclude-manual-review-decision-service\.spec\.ts › /.test(c.label));
  check('R2-1', 'examples recorded from Jest (not "Tests: 0 total")', ex.kind === 'tests' && (ex.tests ?? 0) > 0 && !/Tests:\s+0 total/.test(ex.note ?? ''), JSON.stringify({ kind: ex.kind, tests: ex.tests, note: ex.note }));
  check('R2-1', '≥5 cases from conclude-manual-review-decision-service.spec.ts', conclude.length >= 5, `${conclude.length}`);
  const approveEx = A.g.operations['ConcludeManualReviewDecisionService.approve']?.examples ?? [];
  check('R2-1', 'ConcludeManualReviewDecisionService.approve has an approved case and a NotFoundException case', approveEx.some((e) => /NotFoundException/.test(e.error ?? '')) && approveEx.some((e) => e.output?.status === 'APPROVED'), `${approveEx.length} examples`);

  const kinds = (A.g.incomplete ?? []).map((i) => i.kind);
  check('F5', 'INCOMPLETE with missing-entry-points and unknown-side-effects', kinds.includes('missing-entry-points') && kinds.includes('unknown-side-effects'), kinds.join(', '));
  const reg = suggestion(A.g, 'missing-entry-points');
  check('R2-3', 'suggests { "map": "ConsumerHandlerMap", "method": "handleMessages", "kind": "consumer" }', /"map":\s*"ConsumerHandlerMap"[^}]*"method":\s*"handleMessages"[^}]*"kind":\s*"consumer"/.test(reg), reg);
  check('R2-4', 'suggests { "argv": "src/main.ts", "kind": "cron" }', /"argv":\s*"src\/main\.ts"[^}]*"kind":\s*"cron"/.test(reg), reg);
  const sinks = suggestion(A.g, 'unknown-side-effects');
  check('R2-5', 'suggests AvroProducer.send with "target": "arg:0.topic"', /"class":\s*"AvroProducer"[^}]*"method":\s*"send"[^}]*"target":\s*"arg:0\.topic"/.test(sinks), sinks);
  check('R2-5', 'suggests TypeORMOutboxService.createOutboxMessage as kind outbox', /"class":\s*"TypeORMOutboxService"[^}]*"method":\s*"createOutboxMessage"[^}]*"kind":\s*"outbox"/.test(sinks), sinks);
  check('R2-5', 'suggests no factory / lifecycle method (producer, consumer, connect, disconnect, isHealthy, forRootAsync, register)', !/"method":\s*"(producer|consumer|connect|disconnect|isHealthy|forRootAsync|register)"/.test(sinks), sinks);
  check('R2-5', 'suggests no "const:<package name>" target', !/"target":\s*"const:(nestjs-kafkajs|typeorm-outbox-writer|@acme)/.test(sinks), sinks);
  const txt = itemsText(A.g);
  check('R2-8', '@nestjs/microservices is not flagged (its only import is a type)', !/@nestjs\/microservices/.test(txt), txt.split('\n').find((l) => l.includes('microservices')));
  check('R2-8', 'nothing under .local/ is counted', !/\.local\//.test(txt), txt.split('\n').find((l) => l.includes('.local/')));
  const bogus = entries(A.g).filter((e) => /\?|undefined/.test(e.label));
  check('R2-10', 'no entry point with an unknown label ("topic ?")', bogus.length === 0, bogus.map((e) => `${e.kind} ${e.label} (${e.file}:${e.line})`).join(', '));

  // ── 2. No profile, working tree (no --head): also runs through the temp worktree ─────────────────────────
  console.log('\n2. no profile, working tree');
  const B = analyze(home('b-worktree'), ['--lazy']);
  const exB = B.g.source.examples ?? {};
  check('R2-1', 'working-tree run records examples too', exB.kind === 'tests' && (exB.tests ?? 0) > 0, JSON.stringify({ kind: exB.kind, tests: exB.tests, note: exB.note }));

  // ── 3. With the profile, full ─────────────────────────────────────────────────────────────────────────────
  console.log('\n3. with the profile, full');
  const C = analyze(home('c-profile', true), ['--head', BRANCH]);
  const consumers = entries(C.g, 'consumer').map((e) => e.label).sort();
  const wantC = CONSUMER_KEYS.map((k) => `kafka consumer ${k}`).sort();
  const missC = wantC.filter((l) => !consumers.includes(l));
  const extraC = consumers.filter((l) => !wantC.includes(l));
  check('R2-3', `exactly the 29 handler-map consumers (got ${consumers.length})`, !missC.length && !extraC.length, `missing ${missC.join(', ') || '-'}; extra ${extraC.join(', ') || '-'}`);
  const crons = entries(C.g, 'cron').map((e) => e.label).sort();
  const wantJ = JOBS.map((j) => `job ${j}`).sort();
  const missJ = wantJ.filter((l) => !crons.includes(l));
  const extraJ = crons.filter((l) => !wantJ.includes(l));
  check('R2-4', `exactly the 7 jobs (got ${crons.length})`, !missJ.length && !extraJ.length, `missing ${missJ.join(', ') || '-'}; extra ${extraJ.join(', ') || '-'}`);
  const byLabel = Object.fromEntries(entries(C.g).map((e) => [e.label, e]));
  const notReached = MUST_REACH.filter((l) => !byLabel[l]?.containsChanges);
  check('R2-3/4', 'the 5 inherited sync handlers, review-decision-requested and 2 jobs reach the change', !notReached.length, `not reaching: ${notReached.join(', ')}`);
  for (const [op, topic] of Object.entries(TOPICS)) {
    const got = effectsOf(C.g, op).filter((e) => e.kind === 'kafka').map((e) => e.target);
    check('R2-5', `${op} → kafka ${topic}`, got.includes(topic), got.join(', ') || 'no kafka effect');
  }
  for (const [op, type] of Object.entries(OUTBOX)) {
    const got = effectsOf(C.g, op).filter((e) => e.kind === 'outbox').map((e) => e.target);
    check('R2-5', `${op} → outbox ${type}`, got.includes(type), got.join(', ') || 'no outbox effect');
  }
  const raw = [...new Set(allEffects(C.g).filter((e) => (e.kind === 'kafka' || e.kind === 'outbox') && RAW.test(e.target)).map((e) => `${e.kind} ${e.target}`))];
  check('R2-5', 'no Kafka / outbox target is a code expression', !raw.length, raw.join(', '));
  const audit = effectsOf(C.g, 'RecordEventsProducer.publishRaw').filter((e) => e.kind === 'kafka').map((e) => e.target);
  if (audit.includes('KAFKA_TOPICS.MANUAL_REVIEW_AUDIT')) note('R2-5', 'publishRaw (topic from a parameter) resolved through its only caller: KAFKA_TOPICS.MANUAL_REVIEW_AUDIT');
  else note('R2-5', `publishRaw (topic from a parameter) shows ${audit.join(', ') || 'nothing'}: fine if it is not a raw expression`);
  check('R2-8', 'no effect from .local/ (topic local-test)', !allEffects(C.g).some((e) => e.target === 'local-test' || /\.local\//.test(e.file ?? '')));
  check('F5', 'with the profile nothing is incomplete', !(C.g.incomplete ?? []).length, (C.g.incomplete ?? []).map((i) => `${i.kind}: ${(i.items ?? []).join(' | ')}`).join('; '));
  const needs = C.brief.split('## Needs a description')[1]?.split('\n## ')[0] ?? '';
  const workerLine = needs.split('\n').find((l) => l.includes('ConcludeManualReviewDecisionService.approve')) ?? '';
  if (/Approve user record/.test(workerLine)) note('R2-9', 'worker approve shows the facade/endpoint description as context');
  else note('R2-9', `worker approve has no "called by: Approve user record" context (optional): ${workerLine.trim() || 'not listed'}`);

  // ── 4. With the profile, lazy: same entry points as full ──────────────────────────────────────────────────
  console.log('\n4. with the profile, lazy');
  const D = analyze(home('d-profile-lazy', true), ['--head', BRANCH, '--lazy']);
  const count = (g, k) => entries(g, k).length;
  check('lazy', `lazy lists the same consumers and jobs as full (${count(D.g, 'consumer')}/${count(C.g, 'consumer')}, ${count(D.g, 'cron')}/${count(C.g, 'cron')})`, count(D.g, 'consumer') === count(C.g, 'consumer') && count(D.g, 'cron') === count(C.g, 'cron'));

  // ── 5. UI ─────────────────────────────────────────────────────────────────────────────────────────────────
  if (opt.ui) {
    console.log('\n5. UI (1440×900)');
    await ui(hA, A.id, home('e-ui-profile', true));
  } else note('ui', 'UI checks not run (pass --ui): R2-2 and R2-6 are NOT verified');

  // ── 6. Fresh clone ────────────────────────────────────────────────────────────────────────────────────────
  if (opt['fresh-clone']) {
    console.log('\n6. fresh clone');
    const dir = join(work, 'clone');
    const sh = (cmd, cwd) => spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', env: { ...process.env, MODULEGRAPH_HOME: join(work, 'clone-home'), MODULEGRAPH_SKILLS_DIR: join(work, 'clone-skills') } });
    const cl = sh(`git clone --quiet "${opt['fresh-clone']}" "${dir}"`, work);
    const st = cl.status === 0 ? sh('npm run setup', dir) : cl;
    const t = st.status === 0 ? sh('npm test', dir) : st;
    check('R2-7', 'git clone → npm run setup → npm test passes', cl.status === 0 && st.status === 0 && t.status === 0, (t.stdout + t.stderr).split('\n').filter((l) => /✖|failed:|Not a valid/.test(l)).slice(0, 5).join(' | '));
  } else note('R2-7', 'fresh clone not run (pass --fresh-clone <url>): R2-7 is NOT verified');
} catch (e) {
  check('run', 'the runs completed', false, String(e?.stack ?? e));
} finally {
  if (!opt.keep) rmSync(work, { recursive: true, force: true });
  else console.log(`\nkept ${work}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks pass${failed.length ? `; failing: ${[...new Set(failed.map((f) => f.id))].join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);

async function ui(hNoProfile, id, hProfile) {
  let chromium;
  try {
    ({ chromium } = createRequire(join(mg, 'analyzer/package.json'))('playwright-core'));
  } catch {
    return check('ui', 'playwright-core loads from the modulegraph checkout', false);
  }
  let browser;
  for (const channel of ['msedge', 'chrome']) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch {}
  }
  if (!browser) return check('ui', 'an installed Edge or Chrome', false);
  const PORT = 5197;
  const serve = (h) => spawn(process.execPath, [bin, 'open', id, '--no-open', '--port', String(PORT), '--idle', '5'], { cwd: fx, env: { ...process.env, MODULEGRAPH_HOME: h }, stdio: 'ignore' });
  const up = async () => { for (let i = 0; i < 300; i++) { try { const r = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json(); if (r.graphs?.includes(id)) return true; } catch {} await new Promise((r) => setTimeout(r, 400)); } return false; };
  const down = () => fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST', headers: { 'x-modulegraph': 'stop' } }).catch(() => undefined);
  const go = async (page, hash) => {
    await page.goto(`http://127.0.0.1:${PORT}/?r=${Date.now()}#g=${id}${hash ? `&${hash}` : ''}`);
    await page.waitForSelector('.react-flow__node', { timeout: 60_000 });
    await page.waitForTimeout(1500);
  };
  try {
    let child = serve(hNoProfile);
    if (!(await up())) return check('ui', '`modulegraph open` serves the no-profile review', false);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await go(page, '');
    const verdict = async (pg) => pg.evaluate(() => [...document.querySelectorAll('.topbar, .checks-button')].map((e) => e.textContent ?? '').join(' · '));
    const bar = await verdict(page);
    check('R2-2', 'top bar / checks button of the no-profile review say "incomplete" and not "all clear"', /incomplete/i.test(bar) && !/all clear/i.test(bar), bar.replace(/\s+/g, ' ').slice(0, 300));
    await page.evaluate(() => [...document.querySelectorAll('.checks-button, .topbar button')].filter((b) => /incomplete|checks/i.test(b.textContent ?? '')).forEach((b) => b.click()));
    await page.waitForTimeout(800);
    const body = await page.evaluate(() => document.body.innerText);
    check('R2-2', 'after opening it, the page lists the missing entry points and the unknown side effects, with the profile JSON to add', /missing entry points|missing-entry-points/i.test(body) && /unknown side effects|unknown-side-effects|look like producers/i.test(body) && /entryRegistries/.test(body), body.replace(/\s+/g, ' ').slice(0, 300));

    // R2-6: inspector code-change rows of the changed worker operation (impact view, its own node).
    await go(page, `v=impact&op=${encodeURIComponent('ConcludeManualReviewDecisionService.approve')}&d=1`);
    await page.evaluate(() => {
      const n = [...document.querySelectorAll('.react-flow__node')].find((x) => /ConcludeManualReviewDecision(Service)?\.approve\(/.test(x.textContent ?? ''));
      (n?.firstElementChild ?? n)?.click();
    });
    await page.waitForSelector('.inspector .fn-row', { timeout: 10_000 }).catch(() => undefined);
    const rows = await page.evaluate(() => [...document.querySelectorAll('.inspector .fn-row')].map((r) => {
      const name = r.querySelector('.fn-name');
      return { full: (r.getAttribute('title') ?? '').split('\n')[0], shown: name?.textContent ?? '', width: name?.clientWidth, needs: name?.scrollWidth, fits: !!name && name.scrollWidth <= name.clientWidth + 1 };
    }));
    check('R2-6', 'inspector of ConcludeManualReviewDecisionService.approve: every changed function name shown uncut at 1440 px', rows.length > 0 && rows.every((r) => r.fits), JSON.stringify(rows));
    await page.close();
    await down();
    await new Promise((r) => child.on('exit', r));

    // With the profile nothing is incomplete: the top bar must not say so.
    const C = analyze(hProfile, ['--head', BRANCH, '--lazy']);
    child = spawn(process.execPath, [bin, 'open', C.id, '--no-open', '--port', String(PORT), '--idle', '5'], { cwd: fx, env: { ...process.env, MODULEGRAPH_HOME: hProfile }, stdio: 'ignore' });
    for (let i = 0; i < 300; i++) { try { if ((await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json()).graphs?.includes(C.id)) break; } catch {} await new Promise((r) => setTimeout(r, 400)); }
    const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await p2.goto(`http://127.0.0.1:${PORT}/?r=${Date.now()}#g=${C.id}`);
    await p2.waitForSelector('.react-flow__node', { timeout: 60_000 });
    await p2.waitForTimeout(1500);
    const bar2 = await verdict(p2);
    check('R2-2', 'with the profile (nothing incomplete) the top bar does not say "incomplete"', !/incomplete/i.test(bar2), bar2.replace(/\s+/g, ' ').slice(0, 200));
    await p2.close();
    await down();
  } finally {
    await browser.close();
  }
}
