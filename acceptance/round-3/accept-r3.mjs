#!/usr/bin/env node
/**
 * Round-3 acceptance check for modulegraph, run on the fixture made by create-r3-fixture.mjs. It includes every
 * round-2 check (as regressions), the round-3 items, and the service-independent invariants of invariants.mjs on
 * every review it makes.
 *
 *   node accept-r3.mjs --modulegraph <modulegraph checkout> --fixture <fixture dir> [--ui] [--fresh-clone <git url>] [--keep]
 *
 * Where it can, it reads the expected counts from the fixture's source at run time (handler-map entries, jobs in
 * main.ts, route decorators), not from modulegraph. The profile of the "with profile" runs is NOT written here: it
 * is what the first run's brief suggests, applied as-is. "Follow your own advice and the review is complete and
 * right" is part of what is checked.
 *
 * DO NOT EDIT the expectations or the fixture to make a check pass. If you believe an expectation is wrong, say which
 * and why in your report and leave it failing. Exit 0 only when every check passes. --ui needs an installed Edge or
 * Chrome (playwright-core from the modulegraph checkout); without one the UI checks FAIL, they are not skipped.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { invariants, RAW_TARGET } from './invariants.mjs';

const { values: opt } = parseArgs({ options: { modulegraph: { type: 'string' }, fixture: { type: 'string' }, ui: { type: 'boolean' }, 'fresh-clone': { type: 'string' }, keep: { type: 'boolean' } } });
if (!opt.modulegraph || !opt.fixture) {
  console.error('usage: node accept-r3.mjs --modulegraph <dir> --fixture <dir> [--ui] [--fresh-clone <git url>] [--keep]');
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const mg = resolve(opt.modulegraph);
const fx = resolve(opt.fixture);
const bin = join(mg, 'bin/modulegraph.mjs');
const BRANCH = 'fix/conclude-review-row-scope';
const SERVICE = 'records-review-service';
const src = (p) => readFileSync(join(fx, p), 'utf8');

// ── Expectations read from the fixture's source ─────────────────────────────────────────────────────────────────
const CONSUMER_KEYS = [...src('src/consumers/consumer-handler.map.ts').matchAll(/\[\s*'([^']+)'\s*,/g)].map((m) => m[1]);
const JOBS = [...(/const modules = \{([^}]*)\}/.exec(src('src/main.ts'))?.[1] ?? '').matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]);
const SYNC_KEYS = CONSUMER_KEYS.filter((k) => k.startsWith('sync-feature-area-'));
/** Entry points that reach the changed code (ConcludeManualReviewDecisionService.approve / setUserRecordManualReviewData). */
const MUST_REACH = ['kafka consumer review-decision-requested', ...SYNC_KEYS.map((k) => `kafka consumer ${k}`), 'job stale-review-concluder', 'job feature-area-resync'];
const KAFKA = {
  'RecordEventsProducer.publishDuplicateFound': 'KAFKA_TOPICS.RECORD_DUPLICATE_FOUND',
  'RecordEventsProducer.publishReviewConcluded': 'KAFKA_TOPICS.REVIEW_CONCLUDED',
};
const OUTBOX = { 'NotificationsOutboxService.notifyReviewConcluded': 'ReviewConcludedNotification', 'RecordMessagesService.updateWithNotificationPayload': 'RecordMessagesSynced' };
/** URL templates: config keys in braces, path parameters in braces, as modulegraph already writes `{PAYMENTS_SERVICE_URL}/accounts`. */
const HTTP = {
  'LocksClient.listLocks': '{LOCKS_SERVICE_BASE_URL}/locks',
  'GeoIpClient.countryOf': '{GEOIP_PROXY_BASE_URL}/ip/{ip}',
  'AssessmentsClient.getAssessmentStatuses': '{ASSESSMENTS_SERVICE_BASE_URL}/v1/internal/entities/{entityId}/assessments/statuses',
  'VendorIdentityClient.getAccessToken': '{VENDOR_WORKFLOW_API_BASE_URL}/v1/oauth2/token',
};
const DB_WRITES = {
  'RecordNationalityService.storeNationalities': ['user_nationalities'],
  'RecordMessagesService.updateWithNotificationPayload': ['record_messages', 'user_records'],
  'UserRecordStatusService.setStatus': ['user_records', 'status_history'],
};
/** Calls into packages that do network I/O and that no adapter knows: they must be flagged, and become effects once the suggested rule is applied. */
const IO_PACKAGES = { '@vendorco/identity-api': ['VendorIdentityClient.getApplicant', 'VendorIdentityClient.startCheck'], 'ssh2-sftp-client': ['SftpClientService.listDirectory', 'SftpClientService.upload'] };
/** In the changed approve(): what runs inside the two-database transaction and what runs outside it. */
const TX_INSIDE = ['db.read user_records', 'call ConcludeManualReviewDecisionService.setUserRecordManualReviewDataForRow', 'db.write review_comments', 'call UserRecordStatusService.setStatus', 'call NotificationsOutboxService.notifyReviewConcluded'];
const TX_OUTSIDE = ['call UserRecordsService.findByGuid', 'call ReviewAuditService.recordDecision', 'call RecordEventsProducer.publishReviewConcluded'];

const results = [];
const check = (id, what, pass, detail = '') => {
  results.push({ id, what, pass });
  console.log(`  ${pass ? '✓' : '✖'} [${id}] ${what}${!pass && detail ? `\n        got: ${String(detail).slice(0, 700)}` : ''}`);
};
const note = (id, what) => console.log(`  · [${id}] ${what}`);
const work = mkdtempSync(join(tmpdir(), 'mg-accept-r3-'));

function home(name, profile) {
  const h = join(work, name);
  mkdirSync(h, { recursive: true });
  if (profile) {
    mkdirSync(join(h, 'configs', SERVICE), { recursive: true });
    writeFileSync(join(h, 'configs', SERVICE, 'modulegraph.config.json'), JSON.stringify(profile, null, 2));
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
  return { g, brief: existsSync(briefFile) ? readFileSync(briefFile, 'utf8') : '', id: file.replace(/\.json$/, '') };
}
const entries = (g, kind) => Object.values(g.entryPoints).filter((e) => !kind || e.kind === kind);
const suggestion = (g, kind) => (g.incomplete ?? []).filter((i) => i.kind === kind).map((i) => i.suggestion ?? '').join('\n');
const itemsText = (g) => (g.incomplete ?? []).flatMap((i) => [i.message, ...(i.items ?? []), i.suggestion ?? '']).join('\n');
const effectsOf = (g, opId) => [...(g.operations[opId]?.effects ?? []), ...(g.scopes[opId]?.steps ?? []).filter((s) => s.effect).map((s) => s.effect)];
const allEffects = (g) => [...Object.values(g.operations).flatMap((o) => o.effects ?? []), ...Object.values(g.entryPoints).flatMap((e) => e.effects ?? [])];
const stepName = (s) => (s.kind === 'effect' ? `${s.effect?.kind} ${s.effect?.target}` : `call ${s.target}`);
function runInvariants(tag, g) {
  for (const r of invariants(g, fx)) check(`${r.id}`, `${tag}: ${r.what}`, r.pass, r.detail);
}
/** The brief's suggested profile, applied as-is. */
function suggestedProfile(g) {
  const p = { service: SERVICE };
  for (const i of g.incomplete ?? []) {
    if (!i.suggestion) continue;
    try {
      Object.assign(p, JSON.parse(`{${i.suggestion}}`));
    } catch (e) {
      check('I6', `the ${i.kind} suggestion is valid profile JSON`, false, `${e.message}: ${i.suggestion}`);
    }
  }
  return p;
}

// ── 0. The fixture is what it claims to be ───────────────────────────────────────────────────────────────────
console.log('\n0. fixture');
check('setup', 'fixture is outside the modulegraph checkout', (() => { const r = relative(mg, fx); return r.startsWith('..') || isAbsolute(r); })(), fx);
const ver = (p) => { try { return JSON.parse(readFileSync(join(fx, p, 'package.json'), 'utf8')).version; } catch { return 'missing'; } };
const top = ver('node_modules/lru-cache');
const nested = ['node_modules/path-scurry/node_modules/lru-cache', 'node_modules/typeorm/node_modules/lru-cache'].map(ver).find((v) => v !== 'missing') ?? 'missing';
check('setup', `own node_modules: top-level lru-cache 5.x (got ${top}), nested lru-cache 10.x under path-scurry/typeorm (got ${nested})`, top.startsWith('5.') && nested.startsWith('10.'));
const branchNow = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: fx, encoding: 'utf8' }).trim();
check('setup', `branch ${BRANCH} checked out`, branchNow === BRANCH, branchNow);
check('setup', `read from the source: ${CONSUMER_KEYS.length} handler-map entries, ${JOBS.length} jobs`, CONSUMER_KEYS.length === 29 && JOBS.length === 7, `${CONSUMER_KEYS.length}, ${JOBS.length}`);
const jest = spawnSync('npx jest --ci', { cwd: fx, shell: true, encoding: 'utf8' });
const jestTests = /Tests:\s+(\d+) passed/.exec(jest.stderr + jest.stdout)?.[1];
check('setup', "the fixture's own `npx jest` passes (10 tests)", jest.status === 0 && jestTests === '10', `exit ${jest.status}, ${jestTests} passed`);

let A, C;
try {
  // ── 1. First run, no profile, lazy, --head (as the module-review skill runs it) ───────────────────────────
  console.log('\n1. no profile, --head, lazy');
  A = analyze(home('a-noprofile'), ['--head', BRANCH, '--lazy']);
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
  check('R2-5', 'suggests no factory / lifecycle method (producer, consumer, connect, disconnect, end, isHealthy, forRootAsync, register)', !/"method":\s*"(producer|consumer|connect|disconnect|end|isHealthy|forRootAsync|register)"/.test(sinks), sinks);
  check('R2-5', 'suggests no "const:<package name>" target for a topic or event', !/"target":\s*"const:(nestjs-kafkajs|typeorm-outbox-writer|@acme)/.test(sinks), sinks);
  const txt = itemsText(A.g);
  check('R2-8', '@nestjs/microservices is not flagged (its only import is a type)', !/@nestjs\/microservices/.test(txt), txt.split('\n').find((l) => l.includes('microservices')));
  check('R2-8', 'nothing under .local/ is counted', !/\.local\//.test(txt), txt.split('\n').find((l) => l.includes('.local/')));
  for (const pkg of Object.keys(IO_PACKAGES)) check('R3-3', `${pkg} (does network I/O, no adapter knows it) is flagged under unknown-side-effects`, (A.g.incomplete ?? []).some((i) => i.kind === 'unknown-side-effects' && (i.items ?? []).some((t) => t.includes(pkg))), (A.g.incomplete ?? []).filter((i) => i.kind === 'unknown-side-effects').flatMap((i) => i.items ?? []).join(' | '));
  check('R3-3', 'the suggested sinks cover both I/O packages', Object.keys(IO_PACKAGES).every((p) => sinks.includes(`"${p}"`)), sinks);
  runInvariants('no profile', A.g);

  // ── 2. No profile, working tree (no --head): also runs through the temp worktree ─────────────────────────
  console.log('\n2. no profile, working tree');
  const B = analyze(home('b-worktree'), ['--lazy']);
  const exB = B.g.source.examples ?? {};
  check('R2-1', 'working-tree run records examples too', exB.kind === 'tests' && (exB.tests ?? 0) > 0, JSON.stringify({ kind: exB.kind, tests: exB.tests, note: exB.note }));

  // ── 3. With the brief's own suggestions, full ─────────────────────────────────────────────────────────────
  console.log('\n3. with the profile the first run suggested, full');
  const profile = suggestedProfile(A.g);
  note('profile', `applied as suggested: ${JSON.stringify(profile)}`);
  C = analyze(home('c-profile', profile), ['--head', BRANCH]);
  check('I6', 'with the suggested profile applied, nothing is incomplete', !(C.g.incomplete ?? []).length, (C.g.incomplete ?? []).map((i) => `${i.kind}: ${(i.items ?? []).join(' | ')}`).join('; '));
  const consumers = entries(C.g, 'consumer').map((e) => e.label).sort();
  const wantC = CONSUMER_KEYS.map((k) => `kafka consumer ${k}`).sort();
  check('R2-3', `exactly the ${wantC.length} handler-map consumers (got ${consumers.length})`, JSON.stringify(consumers) === JSON.stringify(wantC), `missing ${wantC.filter((l) => !consumers.includes(l)).join(', ') || '-'}; extra ${consumers.filter((l) => !wantC.includes(l)).join(', ') || '-'}`);
  const crons = entries(C.g, 'cron').map((e) => e.label).sort();
  const wantJ = JOBS.map((j) => `job ${j}`).sort();
  check('R3-1', `exactly the ${wantJ.length} jobs, one entry point each, labelled "job <name>" (got ${crons.length})`, JSON.stringify(crons) === JSON.stringify(wantJ), `missing ${wantJ.filter((l) => !crons.includes(l)).join(', ') || '-'}; extra ${crons.filter((l) => !wantJ.includes(l)).join(', ') || '-'}`);
  const runJob = entries(C.g, 'cron').find((e) => e.label === 'job duplicate-scan');
  check('R3-1', 'job duplicate-scan (onApplicationBootstrap → this.run()) has the effect of run(): kafka KAFKA_TOPICS.RECORD_DUPLICATE_FOUND', !!runJob && (runJob.effects ?? []).some((f) => f.kind === 'kafka' && f.target === 'KAFKA_TOPICS.RECORD_DUPLICATE_FOUND'), runJob ? JSON.stringify(runJob.effects) : 'no such entry point');
  const byLabel = Object.fromEntries(entries(C.g).map((e) => [e.label, e]));
  const notReached = MUST_REACH.filter((l) => !byLabel[l]?.containsChanges);
  check('R2-3/4', 'the 5 inherited sync handlers, review-decision-requested and 2 jobs reach the change', !notReached.length, `not reaching: ${notReached.join(', ')}`);
  for (const [op, topic] of Object.entries(KAFKA)) {
    const got = effectsOf(C.g, op).filter((e) => e.kind === 'kafka').map((e) => e.target);
    check('R2-5', `${op} → kafka ${topic}`, got.includes(topic), got.join(', ') || 'no kafka effect');
  }
  for (const [op, type] of Object.entries(OUTBOX)) {
    const got = effectsOf(C.g, op).filter((e) => e.kind === 'outbox').map((e) => e.target);
    check('R2-5', `${op} → outbox ${type}`, got.includes(type), got.join(', ') || 'no outbox effect');
  }
  for (const [op, url] of Object.entries(HTTP)) {
    const got = effectsOf(C.g, op).filter((e) => e.kind === 'http').map((e) => e.target);
    check('R3-2', `${op} → http ${url}`, got.includes(url), got.join(', ') || 'no http effect');
  }
  const captcha = effectsOf(C.g, 'CaptchaService.validate').filter((e) => e.kind === 'http').map((e) => e.target);
  check('R3-2', 'CaptchaService.validate (URL in a readonly field) → http challenges.captcha-vendor.example…', captcha.some((t) => t.startsWith('challenges.captcha-vendor.example')), captcha.join(', ') || 'no http effect');
  for (const [pkg, ops] of Object.entries(IO_PACKAGES)) {
    for (const op of ops) {
      const got = effectsOf(C.g, op).filter((e) => !e.kind.startsWith('db.'));
      check('R3-3', `${op} (calls ${pkg}) has a non-database effect with a named target once the suggested rule is applied`, got.length > 0 && got.every((e) => !RAW_TARGET.test(e.target)), got.map((e) => `${e.kind} ${e.target}`).join(', ') || 'no effect');
    }
  }
  check('R3-3', 'SftpClientService.onModuleDestroy (end()) and the SDK constructor are no effects', !effectsOf(C.g, 'SftpClientService.onModuleDestroy').length, JSON.stringify(effectsOf(C.g, 'SftpClientService.onModuleDestroy')));
  for (const [op, tables] of Object.entries(DB_WRITES)) {
    const got = [...new Set(effectsOf(C.g, op).filter((e) => e.kind === 'db.write').map((e) => e.target))];
    check('R3-4', `${op} → db.write ${tables.join(', ')} (and no unnamed write)`, tables.every((t) => got.includes(t)) && got.every((t) => !RAW_TARGET.test(t)), got.join(', ') || 'no db.write');
  }
  const steps = C.g.scopes['ConcludeManualReviewDecisionService.approve']?.steps ?? [];
  const inTx = (name) => steps.filter((s) => stepName(s) === name);
  const insideBad = TX_INSIDE.filter((n) => !inTx(n).length || inTx(n).some((s) => !s.transaction));
  const outsideBad = TX_OUTSIDE.filter((n) => !inTx(n).length || inTx(n).some((s) => s.transaction));
  const fmt = steps.map((s) => `${stepName(s)}${s.transaction ? ` [tx ${s.transaction}]` : ''}`).join(' | ');
  check('R3-5', `approve(): the 5 steps between startTransaction and commit are marked as in the transaction (queryRunner, through a helper, two data sources)`, !insideBad.length, `not marked: ${insideBad.join(', ')} — steps: ${fmt}`);
  check('R3-5', 'approve(): the read before the transaction and the calls after commit are not marked', !outsideBad.length, `wrong: ${outsideBad.join(', ')} — steps: ${fmt}`);
  const txNames = [...new Set(steps.filter((s) => s.transaction).map((s) => s.transaction))];
  check('R3-5', 'the two data sources are told apart (legacy and admin)', txNames.some((t) => /legacy/i.test(t)) && txNames.some((t) => /admin/i.test(t)), txNames.join(', ') || 'no transaction names');
  const raw = [...new Set(allEffects(C.g).filter((e) => RAW_TARGET.test(e.target)).map((e) => `${e.kind} ${e.target}`))];
  check('R2-5', 'no effect target is a code expression or "?"', !raw.length, raw.join(', '));
  check('R2-8', 'no effect from .local/ (topic local-test)', !allEffects(C.g).some((e) => e.target === 'local-test' || /\.local\//.test(e.file ?? '')));
  const needs = C.brief.split('## Needs a description')[1]?.split('\n## ')[0] ?? '';
  const workerLine = needs.split('\n').find((l) => l.includes('ConcludeManualReviewDecisionService.approve')) ?? '';
  check('R3-6', 'the worker approve (behind a facade that calls a helper first) shows "Approve user record" as context in the brief', /Approve user record/.test(workerLine), workerLine.trim() || 'not listed');
  runInvariants('with profile, full', C.g);

  // ── 4. With the profile, lazy: same entry points as full ──────────────────────────────────────────────────
  console.log('\n4. with the profile, lazy');
  const D = analyze(home('d-profile-lazy', profile), ['--head', BRANCH, '--lazy']);
  const count = (g, k) => entries(g, k).length;
  check('lazy', `lazy lists the same consumers and jobs as full (${count(D.g, 'consumer')}/${count(C.g, 'consumer')}, ${count(D.g, 'cron')}/${count(C.g, 'cron')})`, count(D.g, 'consumer') === count(C.g, 'consumer') && count(D.g, 'cron') === count(C.g, 'cron'));
  runInvariants('with profile, lazy', D.g);

  // ── 5. UI ─────────────────────────────────────────────────────────────────────────────────────────────────
  if (opt.ui) {
    console.log('\n5. UI (1440×900)');
    await ui(join(work, 'a-noprofile'), A.id, profile);
  } else note('ui', 'UI checks not run (pass --ui): R2-2, R2-6, R3-6 (UI) and R3-7 are NOT verified');

  // ── 6. Fresh clone ────────────────────────────────────────────────────────────────────────────────────────
  if (opt['fresh-clone']) {
    console.log('\n6. fresh clone');
    const dir = join(work, 'clone');
    const sh = (cmd, cwd) => spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', env: { ...process.env, MODULEGRAPH_HOME: join(work, 'clone-home'), MODULEGRAPH_SKILLS_DIR: join(work, 'clone-skills') } });
    const cl = sh(`git clone --quiet "${opt['fresh-clone']}" "${dir}"`, work);
    const st = cl.status === 0 ? sh('npm run setup', dir) : cl;
    const t = st.status === 0 ? sh('npm test', dir) : st;
    check('R2-7', 'git clone → npm run setup → npm test passes', cl.status === 0 && st.status === 0 && t.status === 0, (t.stdout + t.stderr).split('\n').filter((l) => /✖|failed:|Not a valid|ERR!/.test(l)).slice(0, 5).join(' | '));
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

async function ui(hNoProfile, id, profile) {
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
  const serve = (h, gid) => spawn(process.execPath, [bin, 'open', gid, '--no-open', '--port', String(PORT), '--idle', '5'], { cwd: fx, env: { ...process.env, MODULEGRAPH_HOME: h }, stdio: 'ignore' });
  const up = async (gid) => { for (let i = 0; i < 300; i++) { try { const r = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json(); if (r.graphs?.includes(gid)) return true; } catch {} await new Promise((r) => setTimeout(r, 400)); } return false; };
  const down = () => fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST', headers: { 'x-modulegraph': 'stop' } }).catch(() => undefined);
  const go = async (page, gid, hash) => {
    await page.goto(`http://127.0.0.1:${PORT}/?r=${Date.now()}#g=${gid}${hash ? `&${hash}` : ''}`);
    await page.waitForSelector('.react-flow__node', { timeout: 60_000 });
    await page.waitForTimeout(1500);
  };
  const verdict = async (pg) => pg.evaluate(() => [...document.querySelectorAll('.topbar, .checks-button')].map((e) => e.textContent ?? '').join(' · '));
  try {
    let child = serve(hNoProfile, id);
    if (!(await up(id))) return check('ui', '`modulegraph open` serves the no-profile review', false);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await go(page, id, '');
    const bar = await verdict(page);
    check('R2-2', 'top bar / checks button of the no-profile review say "incomplete" and not "all clear"', /incomplete/i.test(bar) && !/all clear/i.test(bar), bar.replace(/\s+/g, ' ').slice(0, 300));
    await page.evaluate(() => [...document.querySelectorAll('.checks-button, .topbar button')].filter((b) => /incomplete|checks/i.test(b.textContent ?? '')).forEach((b) => b.click()));
    await page.waitForTimeout(800);
    const body = await page.evaluate(() => document.body.innerText);
    check('R2-2', 'after opening it, the page lists the missing entry points and the unknown side effects, with the profile JSON to add', /missing entry points|missing-entry-points/i.test(body) && /unknown side effects|unknown-side-effects|look like producers/i.test(body) && /entryRegistries/.test(body), body.replace(/\s+/g, ' ').slice(0, 300));
    const clipped = await page.evaluate(() => [...document.querySelectorAll('pre, code')].filter((e) => e.offsetParent && /"(entryRegistries|sinks)"/.test(e.textContent ?? '')).map((e) => ({ w: e.clientWidth, need: e.scrollWidth, text: (e.textContent ?? '').slice(0, 40) })).filter((x) => x.need > x.w + 1));
    check('R3-7', 'the suggested profile JSON in the panel is readable without horizontal scrolling (wrapped, not clipped)', !clipped.length, JSON.stringify(clipped));

    // R2-6 and R3-6: inspector of the changed worker operation.
    await go(page, id, `v=impact&op=${encodeURIComponent('ConcludeManualReviewDecisionService.approve')}&d=1`);
    await page.evaluate(() => {
      const n = [...document.querySelectorAll('.react-flow__node')].find((x) => /ConcludeManualReviewDecision(Service)?\.approve\(/.test(x.textContent ?? ''));
      (n?.firstElementChild ?? n)?.click();
    });
    await page.waitForSelector('.inspector .fn-row', { timeout: 10_000 }).catch(() => undefined);
    const insp = await page.evaluate(() => {
      const p = document.querySelector('.inspector');
      const rows = [...(p?.querySelectorAll('.fn-row') ?? [])].map((r) => {
        const name = r.querySelector('.fn-name');
        return { full: (r.getAttribute('title') ?? '').split('\n')[0], width: name?.clientWidth, needs: name?.scrollWidth, fits: !!name && name.scrollWidth <= name.clientWidth + 1 };
      });
      return { rows, text: p?.innerText ?? '' };
    });
    check('R2-6', 'inspector of ConcludeManualReviewDecisionService.approve: every changed function name shown uncut at 1440 px', insp.rows.length > 0 && insp.rows.every((r) => r.fits), JSON.stringify(insp.rows));
    check('R3-6', 'inspector of the worker approve shows "Approve user record" as context (its facade calls a helper first)', /Approve user record/.test(insp.text), insp.text.slice(0, 300));
    await page.close();
    await down();
    await new Promise((r) => child.on('exit', r));

    // With the suggested profile nothing is incomplete: the top bar must not say so.
    const hP = join(work, 'e-ui-profile');
    mkdirSync(join(hP, 'configs', SERVICE), { recursive: true });
    writeFileSync(join(hP, 'configs', SERVICE, 'modulegraph.config.json'), JSON.stringify(profile, null, 2));
    const P = analyze(hP, ['--head', BRANCH, '--lazy']);
    child = serve(hP, P.id);
    await up(P.id);
    const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await go(p2, P.id, '');
    const bar2 = await verdict(p2);
    check('R2-2', 'with the suggested profile (nothing incomplete) the top bar does not say "incomplete"', !/incomplete/i.test(bar2), bar2.replace(/\s+/g, ' ').slice(0, 200));
    await p2.close();
    await down();
  } finally {
    await browser.close();
  }
}
