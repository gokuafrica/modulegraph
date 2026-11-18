#!/usr/bin/env node
/**
 * Round-4 acceptance check for modulegraph, on the fixture made by create-r4-fixture.mjs. Fast on purpose (about a
 * minute): two analyze runs (first run with no profile; then the profile it suggests, applied as-is, full, without
 * Jest), one browser page with --ui, the invariants on both reviews, and the call accounting of accounting.mjs.
 *
 *   node accept-r4.mjs --modulegraph <checkout> --fixture <dir> [--ui] [--only R4-1,R4-3] [--keep]
 *
 * --only shows and counts only those items (plus setup and the invariants), for a quick loop while fixing one thing.
 * DO NOT EDIT the expectations or the fixture to make a check pass; if one looks wrong, leave it failing and say why.
 * Exit 0 only when every shown check passes.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { candidates } from './accounting.mjs';
import { invariants, RAW_TARGET } from './invariants.mjs';

const { values: opt } = parseArgs({ options: { modulegraph: { type: 'string' }, fixture: { type: 'string' }, ui: { type: 'boolean' }, only: { type: 'string' }, keep: { type: 'boolean' } } });
if (!opt.modulegraph || !opt.fixture) {
  console.error('usage: node accept-r4.mjs --modulegraph <dir> --fixture <dir> [--ui] [--only R4-1,R4-3] [--keep]');
  process.exit(2);
}
const t0 = Date.now();
const mg = resolve(opt.modulegraph);
const fx = resolve(opt.fixture);
const bin = join(mg, 'bin/modulegraph.mjs');
const BRANCH = 'fix/conclude-review-row-scope';
const SERVICE = 'records-review-service';
const only = opt.only ? new Set(opt.only.split(',').map((s) => s.trim())) : undefined;
const GAP_REASONS = new Set(['function-value', 'interface-dispatch', 'untyped', 'dynamic']);
const W = 'ConcludeManualReviewDecisionService';

/** Exact expectations, for code where everything is typed and in the project: no gap is acceptable here. */
const TX = {
  [`${W}.approve`]: {
    inside: [`call ${W}.setUserRecordManualReviewDataForRow`, 'db.write review_comments', 'db.write action_logs', 'call UserRecordStatusService.setStatus', 'call NotificationsOutboxService.notifyReviewConcluded'],
    outside: ['call UserRecordsService.findByGuid', 'call ReviewAuditService.recordDecision', 'call RecordEventsProducer.publishReviewConcluded'],
    /** The callbacks run in executeQueries(), after setStatus: their steps come after it. */
    after: ['call UserRecordStatusService.setStatus', [`call ${W}.setUserRecordManualReviewDataForRow`, 'db.write review_comments', 'db.write action_logs']],
  },
  [`${W}.updateUserRecordData`]: {
    inside: [`call ${W}.setUserRecordManualReviewDataForRow`, 'db.write action_logs'],
    outside: ['call UserRecordsService.findByGuid'],
  },
};
const NO_GAPS = [`${W}.approve`, `${W}.updateUserRecordData`, `${W}.reject`, `${W}.setUserRecordManualReviewData`];
const HTTP = {
  'AssessmentsClient.getAssessmentStatuses': '{ASSESSMENT_SERVICE_CONFIG.baseUrl}/v1/internal/entities/{entityId}/assessments/statuses',
  'IdentityManagerClient.checkPassword': '{IDENTITY_MANAGER_CONFIG.baseUrl}/api/v1/manage/users/authenticate',
};

const results = [];
const check = (id, what, pass, detail = '') => {
  if (only && !only.has(id) && !/^(I\d|setup|run)/.test(id)) return;
  results.push({ id, what, pass });
  console.log(`  ${pass ? '✓' : '✖'} [${id}] ${what}${!pass && detail ? `\n        got: ${String(detail).slice(0, 700)}` : ''}`);
};
const section = (title) => console.log(`\n${title}  (${Math.round((Date.now() - t0) / 1000)} s)`);
const work = mkdtempSync(join(tmpdir(), 'mg-accept-r4-'));

function analyze(name, profile, args) {
  const h = join(work, name);
  mkdirSync(join(h, 'configs', SERVICE), { recursive: true });
  if (profile) writeFileSync(join(h, 'configs', SERVICE, 'modulegraph.config.json'), JSON.stringify(profile, null, 2));
  const r = spawnSync(process.execPath, [bin, 'analyze', '--project', fx, ...args], { cwd: fx, env: { ...process.env, MODULEGRAPH_HOME: h }, encoding: 'utf8', timeout: 600_000 });
  const dir = join(h, 'reviews');
  const file = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.json') && !f.startsWith('index') && !f.endsWith('.explain.json')) : undefined;
  if (!file) {
    console.log(r.stdout, r.stderr);
    throw new Error(`analyze ${args.join(' ')} wrote no review`);
  }
  const id = file.replace(/\.json$/, '');
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : undefined);
  const explain = read(`${id}.explain.json`);
  return { h, id, g: JSON.parse(read(file)), brief: read(`${id}.brief.md`) ?? '', explain: explain ? JSON.parse(explain) : undefined, stderr: r.stderr };
}
const effectsOf = (g, op) => [...(g.operations[op]?.effects ?? []), ...(g.scopes[op]?.steps ?? []).filter((s) => s.effect).map((s) => s.effect)];
const stepName = (s) => (s.kind === 'effect' ? `${s.effect?.kind} ${s.effect?.target}` : `call ${s.target}`);
const fmtSteps = (steps) => steps.map((s) => `${stepName(s)}${s.transaction ? ` [tx ${s.transaction}]` : ''}`).join(' | ');
const runInvariants = (tag, g) => { for (const r of invariants(g, fx)) check(r.id, `${tag}: ${r.what}`, r.pass, r.detail); };

section('0. fixture');
check('setup', 'fixture is outside the modulegraph checkout', (() => { const r = relative(mg, fx); return r.startsWith('..') || isAbsolute(r); })(), fx);
check('setup', `branch ${BRANCH} checked out`, execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: fx, encoding: 'utf8' }).trim() === BRANCH);

try {
  section('1. first run: no profile, --head, lazy (as the module-review skill runs it)');
  const A = analyze('a', undefined, ['--head', BRANCH, '--lazy']);
  runInvariants('first run', A.g);
  const profile = { service: SERVICE };
  for (const i of A.g.incomplete ?? []) if (i.suggestion) Object.assign(profile, JSON.parse(`{${i.suggestion}}`));

  section('2. the suggested profile applied as-is, full, --no-tests, --explain');
  // R4-7: the agent's blind check writes its disagreements into the profile; modulegraph shows them, never acts on them.
  const NOTE = 'agent check: the comment insert at line 147 runs before commit, inside the admin transaction';
  profile.disagreements = { [`${W}.updateUserRecordData`]: [{ line: 147, note: NOTE }] };
  let C;
  try {
    C = analyze('c', profile, ['--head', BRANCH, '--no-tests', '--explain']);
  } catch {
    // An older modulegraph rejects --explain: analyze without it, so the other checks still report.
    rmSync(join(work, 'c'), { recursive: true, force: true });
    C = analyze('c', profile, ['--head', BRANCH, '--no-tests']);
  }
  runInvariants('suggested profile', C.g);
  check('I6', 'suggested profile: nothing is incomplete', !(C.g.incomplete ?? []).length, (C.g.incomplete ?? []).map((i) => `${i.kind}: ${(i.items ?? []).join(' | ')}`).join('; '));

  // ── R4-1 Accounting: every call through a value and every function literal handed on is followed or a named gap.
  const ops = Object.values(C.g.operations).filter((o) => o.file && o.line && o.endLine && C.g.scopes[o.id]);
  const cands = candidates(mg, fx, ops);
  check('R4-1', `--explain wrote <id>.explain.json with an entry per analyzed operation (${ops.length})`, !!C.explain && ops.every((o) => Array.isArray(C.explain[o.id])), C.explain ? `missing: ${ops.filter((o) => !Array.isArray(C.explain[o.id])).map((o) => o.id).slice(0, 8).join(', ')}` : 'no explain file');
  const unaccounted = [];
  for (const c of cands) {
    const e = (C.explain?.[c.op] ?? []).find((x) => x.line === c.line && (x.disposition === 'followed' || (x.disposition === 'gap' && GAP_REASONS.has(x.reason))));
    if (!e) unaccounted.push(`${c.op} L${c.line} ${c.kind}: ${c.text.replace(/\s+/g, ' ')}`);
    else if (e.disposition === 'gap' && !(C.g.operations[c.op]?.gaps ?? []).some((x) => x.line === c.line)) unaccounted.push(`${c.op} L${c.line}: a gap in --explain but not in operations[].gaps`);
  }
  check('R4-1', `all ${cands.length} calls through values / function literals handed on (found independently from the source) are "followed" or a named "gap"`, cands.length > 0 && !unaccounted.length, unaccounted.join(' | '));
  for (const op of NO_GAPS) check('R4-1', `${op}: fully typed project code, so no gap`, !(C.g.operations[op]?.gaps ?? []).length, JSON.stringify(C.g.operations[op]?.gaps));
  const opsWithGaps = ops.filter((o) => (C.g.operations[o.id]?.gaps ?? []).length);
  check('R4-1', `gap budget: at most 10% of analyzed operations carry a gap (${opsWithGaps.length}/${ops.length})`, opsWithGaps.length <= Math.ceil(ops.length * 0.1), opsWithGaps.map((o) => o.id).join(', '));

  // ── R4-2 Execution order and transaction membership.
  for (const [op, want] of Object.entries(TX)) {
    const steps = C.g.scopes[op]?.steps ?? [];
    const named = (n) => steps.filter((s) => stepName(s) === n);
    const inBad = want.inside.filter((n) => !named(n).length || named(n).some((s) => !s.transaction));
    const outBad = want.outside.filter((n) => !named(n).length || named(n).some((s) => s.transaction));
    check('R4-2', `${op}: the steps that run between start and commit (callbacks run by executeQueries included) are in the transaction`, !inBad.length, `not marked: ${inBad.join(', ')} — ${fmtSteps(steps)}`);
    check('R4-2', `${op}: the read before and the calls after the commit are outside it`, !outBad.length, `wrong: ${outBad.join(', ')} — ${fmtSteps(steps)}`);
    if (want.after) {
      const [first, later] = want.after;
      const at = steps.findIndex((s) => stepName(s) === first);
      const before = later.filter((n) => { const i = steps.findIndex((s) => stepName(s) === n); return i < 0 || i < at; });
      check('R4-2', `${op}: the callbacks' steps come after ${first.replace('call ', '')} (where executeQueries runs them), not where they are written`, at >= 0 && !before.length, `placed before or missing: ${before.join(', ')} — ${fmtSteps(steps)}`);
    }
  }
  const txNames = [...new Set((C.g.scopes[`${W}.approve`]?.steps ?? []).filter((s) => s.transaction).map((s) => s.transaction))];
  check('R4-2', 'two data sources are named as two transactions with separate commits, not as one', txNames.length > 0 && txNames.every((t) => /2 transactions|separate commits/i.test(t) && !/\bone\b/i.test(t)), txNames.join(', ') || 'no transaction');
  const nat = C.g.scopes['RecordNationalityService.storeNationalities']?.steps ?? [];
  const auditStep = nat.find((s) => stepName(s) === 'call NationalityAuditService.record');
  check('R4-2', 'storeNationalities: the audit call inside manager.transaction(cb) writes through its own repository, not the manager: it is NOT in the transaction', !!auditStep && !auditStep.transaction, auditStep ? fmtSteps(nat) : 'no audit step');
  check('R4-2', 'storeNationalities: the writes through the transaction\'s manager are in it', nat.filter((s) => stepName(s) === 'db.write user_nationalities').length > 0 && nat.filter((s) => stepName(s) === 'db.write user_nationalities').every((s) => s.transaction), fmtSteps(nat));
  const rs = C.g.scopes['ReassignmentService.reassign']?.steps ?? [];
  const rsPlaced = ['db.write review_comments', 'db.write user_records'].every((n) => rs.some((s) => stepName(s) === n && s.transaction));
  const rsGap = (C.g.operations['ReassignmentService.reassign']?.gaps ?? []).some((x) => x.reason === 'interface-dispatch');
  check('R4-2', 'reassign(): the strategy steps\' writes are in the transaction (both implementations followed), OR it carries an interface-dispatch gap', rsPlaced || rsGap, `steps: ${fmtSteps(rs) || 'none'}; gaps: ${JSON.stringify(C.g.operations['ReassignmentService.reassign']?.gaps ?? [])}`);
  // Regressions: these already work and must keep working.
  check('R4-2', 'retry(() => …) is followed: RecordLocksService.freeze writes user_records', effectsOf(C.g, 'RecordLocksService.freeze').some((e) => e.kind === 'db.write' && e.target === 'user_records'));
  check('R4-2', 'an abstract class with one implementation is followed: DocumentArchiveService.archive → http {FILE_STORE_URL}/objects/{key}', effectsOf(C.g, 'DocumentArchiveService.archive').some((e) => e.kind === 'http' && e.target === '{FILE_STORE_URL}/objects/{key}'));

  // ── R4-3 A pure function from a package that also has a network client.
  const dl = effectsOf(C.g, 'DocumentLinksService.downloadLink');
  check('R4-3', 'DocumentLinksService.downloadLink (signUrl: local HMAC) has no side effect', !dl.length, dl.map((e) => `${e.kind} ${e.target}`).join(', '));
  for (const op of ['VendorIdentityClient.getApplicant', 'SftpClientService.upload']) {
    const got = effectsOf(C.g, op).filter((e) => !e.kind.startsWith('db.'));
    check('R4-3', `${op} still has its network effect`, got.length > 0 && got.every((e) => !RAW_TARGET.test(e.target)), got.map((e) => `${e.kind} ${e.target}`).join(', ') || 'none');
  }

  // ── R4-4 URLs from a config object's property and from destructuring.
  for (const [op, url] of Object.entries(HTTP)) {
    const got = effectsOf(C.g, op).filter((e) => e.kind === 'http').map((e) => e.target);
    check('R4-4', `${op} → http ${url}`, got.includes(url), got.join(', ') || 'no http effect');
  }

  // ── R4-7 Disagreements from the agent's blind check: shown at the top of the brief and on the operation, steps untouched.
  const top = C.brief.split('\n## Changes')[0];
  check('R4-7', 'a profile "disagreements" entry appears before the changes in the brief, with its note and line', top.includes(NOTE) && /disagree/i.test(top), top.slice(-400));
  check('R4-7', 'and on the operation in the review JSON (operations[].disagreements), without changing its steps', (C.g.operations[`${W}.updateUserRecordData`]?.disagreements ?? []).some((d) => d.note === NOTE && d.line === 147), JSON.stringify(C.g.operations[`${W}.updateUserRecordData`]?.disagreements));

  // ── R4-6 The brief states the behaviour change: a new row lock.
  const sec = C.brief.split(/^### \d+\. /m).find((s) => s.startsWith(`ConcludeManualReviewDecision.setUserRecordManualReviewData:`) || s.startsWith(`${W}.setUserRecordManualReviewData:`)) ?? '';
  check('R4-6', 'brief: setUserRecordManualReviewData\'s "Behaviour inside" says the new read locks the rows (pessimistic write)', /lock/i.test(sec), sec.split('\n').slice(0, 8).join(' / ').slice(0, 400) || 'section not found');

  if (opt.ui && (!only || ['R4-2', 'R4-3', 'R4-5'].some((i) => only.has(i)))) {
    section('3. UI (1440×900)');
    await ui(A, C);
  } else if (!opt.ui) console.log('\n  · UI not run (pass --ui): R4-2 (label), R4-3 (panel) and R4-5 are NOT verified');
} catch (e) {
  check('run', 'the runs completed', false, String(e?.stack ?? e));
} finally {
  if (!opt.keep) rmSync(work, { recursive: true, force: true });
  else console.log(`\nkept ${work}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks pass in ${Math.round((Date.now() - t0) / 1000)} s${failed.length ? `; failing: ${[...new Set(failed.map((f) => f.id))].join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);

async function ui(A, C) {
  let chromium;
  try {
    ({ chromium } = createRequire(join(mg, 'analyzer/package.json'))('playwright-core'));
  } catch {
    return check('R4-3', 'playwright-core loads from the modulegraph checkout', false);
  }
  let browser;
  for (const channel of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel, headless: true }); break; } catch {}
  }
  if (!browser) return check('R4-3', 'an installed Edge or Chrome', false);
  const PORT = 5198;
  const serve = (R) => spawn(process.execPath, [bin, 'open', R.id, '--no-open', '--port', String(PORT), '--idle', '5'], { cwd: fx, env: { ...process.env, MODULEGRAPH_HOME: R.h }, stdio: 'ignore' });
  const up = async (R) => { for (let i = 0; i < 300; i++) { try { if ((await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json()).graphs?.includes(R.id)) return true; } catch {} await new Promise((r) => setTimeout(r, 400)); } return false; };
  const down = () => fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST', headers: { 'x-modulegraph': 'stop' } }).catch(() => undefined);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const go = async (R, hash) => {
    await page.goto(`http://127.0.0.1:${PORT}/?r=${Date.now()}#g=${R.id}${hash ? `&${hash}` : ''}`);
    await page.waitForSelector('.react-flow__node', { timeout: 60_000 });
    await page.waitForTimeout(1200);
  };
  const clickNode = (re) => page.evaluate((src) => { const n = [...document.querySelectorAll('.react-flow__node')].find((x) => new RegExp(src).test(x.textContent ?? '')); (n?.firstElementChild ?? n)?.click(); }, re);
  try {
    let child = serve(A);
    await up(A);
    // R4-3: one click on "incomplete" shows each flagged item and its rule.
    await go(A, '');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /incomplete/i.test(b.textContent ?? ''))?.click());
    await page.waitForTimeout(800);
    const visible = await page.evaluate(() => document.body.innerText);
    const pkgs = ['@vendorco/identity-api', 'ssh2-sftp-client'];
    const lines = pkgs.filter((p) => visible.split('\n').some((l) => l.includes(`${p} (`) && !l.includes('"module"')));
    check('R4-3', 'one click on "incomplete" shows each flagged item (package and why) and its rule, without a further click', lines.length === pkgs.length && /"sinks"/.test(visible), `item lines visible for: ${lines.join(', ') || 'none'}; ${/"sinks"/.test(visible) ? 'rule shown' : 'no rule shown'}`);
    // R4-5: unchanged undescribed operation: a quiet line, not the "Ask your agent" block; the changed one still asks.
    await go(A, `v=impact&op=${encodeURIComponent('UserRecordsService.findByGuid')}&d=0`);
    await clickNode('UserRecords(Service)?\\.findByGuid\\(');
    await page.waitForTimeout(800);
    const insp = await page.evaluate(() => document.querySelector('.inspector')?.innerText ?? '');
    check('R4-5', 'unchanged, undescribed operation (UserRecordsService.findByGuid): no "Ask your agent" block, no profile JSON', !!insp && !/Ask your agent/i.test(insp) && !/"overrides"/.test(insp), insp.slice(0, 300) || 'inspector did not open');
    await go(A, `v=impact&op=${encodeURIComponent(`${W}.approve`)}&d=1`);
    await clickNode('ConcludeManualReviewDecision(Service)?\\.approve\\(');
    await page.waitForTimeout(800);
    const insp2 = await page.evaluate(() => document.querySelector('.inspector')?.innerText ?? '');
    check('R4-5', 'the changed, undescribed operation still asks for a description (required)', /describe|description/i.test(insp2), insp2.slice(0, 200));
    await down();
    await new Promise((r) => child.on('exit', r));

    // R4-2: the drawn label of the two-database transaction.
    child = serve(C);
    await up(C);
    await go(C, `v=flow&t=${encodeURIComponent('api:PUT /api/v1/internal/manual-review/approve/:guid')}|${encodeURIComponent(`${W}.approve`)}`);
    const tx = await page.evaluate(() => [...document.querySelectorAll('.react-flow__node')].map((n) => n.textContent ?? '').filter((t) => /transaction/i.test(t)).join(' | '));
    check('R4-2', 'the flow labels the two-database box as 2 transactions with separate commits, not "one transaction"', /2 transactions|separate commits/i.test(tx) && !/one transaction/i.test(tx), tx.slice(0, 200) || 'no transaction box drawn');
    await down();
  } finally {
    await browser.close();
  }
}
