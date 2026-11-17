/**
 * Checks that lazy analysis agrees with full analysis on everything it has analyzed, and that it really
 * analyzed less. Runs both on the demo branches, then expands the lazy graph the way a reviewer would, then edits
 * the code (a reviewer's local fix) and refreshes: the refreshed graph must match a full analysis of the edited code.
 * usage: npm run lazy-check --workspace analyzer
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleGraph } from '../../schema/modulegraph.ts';
import { typescript } from './analyzers/typescript/index.ts';
import { compare } from './compare.ts';
import { loadConfig } from './config.ts';
import { effectKey } from './effects.ts';
import { diffBetween, filesAtRef, mergeBase, revParse } from './git.ts';
import { LazySession } from './lazy.ts';
import { reviewSummary } from './rules.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..').replace(/\\/g, '/');

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  ✖ ${msg}`);
};
const keys = (es: { kind: string; target: string }[]) => es.map((e) => effectKey(e as never)).sort().join(', ');

/** A local fix per branch, as a reviewer would make it: [file, find, replace]. */
type Fix = readonly [string, string, string];
for (const [projectRel, profile, branch, intent, fix] of [
  ['sample-service', 'identity-profile-service', 'feature/birthinfo-consent', 'BirthInfo: prefer user-consented birth data over document data; add consent endpoint.',
    // drop the undisclosed outbox event
    ['sample-service/src/modules/birth-info/BirthInfoModule.ts', "      await this.outbox.enqueue('birth_info.source_resolved', { userId: identity.userId, source: info.source });\n", '']],
  ['sample-service', 'identity-profile-service', 'feature/kyc-risk-tiers', 'KYC: risk tiers, manual review, async nightly rescreen.',
    // a new side effect
    ['sample-service/src/modules/kyc/KycModule.ts', "await this.outbox.enqueue('kyc.completed', { ...result });", "await this.outbox.enqueue('kyc.completed', { ...result });\n      await this.outbox.enqueue('kyc.audited', { userId });"]],
  // NestJS: decorator entry points, framework sinks, constructor injection through @Inject* decorators
  ['sample-nest-service', 'order-service', 'feature/order-fraud-hold', 'Orders: hold high-risk orders for fraud review; release endpoint; fraud desk decisions; loyalty discounts; carrier status from events.',
    // a changed guard: held orders never reserved stock
    ['sample-nest-service/src/orders/orders.service.ts', '    await this.inventory.release(order.lines);', "    if (order.status !== 'held') await this.inventory.release(order.lines);"]],
  ['sample-birth-service', 'birth-info-service', 'feature/enforce-document-birth-info', 'BirthInfo: enforce document birth info on KYC submissions.',
    // a new event after a verified submission
    ['sample-birth-service/src/birth-info/birth-info.service.ts', '      await this.kyc.save(userId, submitted, manager);', "      await this.kyc.save(userId, submitted, manager);\n      this.events.emit('kyc.birth_info.verified', { userId, enforced: check.enforced });"]],
  // A realistic in-house service: no profile (the first run), then with the rules that run suggests.
  ['sample-legacy-nest-service', '', 'fix/scope-manual-data-to-row', 'fix: scope manual data to each user record row',
    // normalize the agent's data before merging it (a new call)
    ['sample-legacy-nest-service/src/manual-review/services/conclude-manual-review-decision-service.ts', 'const merged = { ...row.data, ...agentData };', 'const merged = { ...row.data, ...this.userRecordDataTransformer.normalize(agentData) };']],
  ['sample-legacy-nest-service', 'user-records-service.rules', 'fix/scope-manual-data-to-row', 'fix: scope manual data to each user record row',
    ['sample-legacy-nest-service/src/manual-review/services/conclude-manual-review-decision-service.ts', 'const merged = { ...row.data, ...agentData };', 'const merged = { ...row.data, ...this.userRecordDataTransformer.normalize(agentData) };']],
] as const satisfies readonly (readonly [string, string, string, string, Fix])[]) {
  console.log(`\n${projectRel} ${branch}`);
  const projectDir = join(repo, projectRel).replace(/\\/g, '/');
  const config = loadConfig(projectDir, profile ? join(repo, `configs/${profile}/modulegraph.config.json`) : undefined);
  if (!profile) console.log('  (no profile)');
  const project = (files: Map<string, string>) => typescript.open({ repo, projectDir, config, files });
  const mb = mergeBase(repo, 'main', branch);
  const headFiles = filesAtRef(repo, revParse(repo, branch), projectRel);
  const baseFiles = filesAtRef(repo, mb, projectRel);
  const diff = diffBetween(repo, mb, branch, projectRel);

  let t = performance.now();
  let full = compare(project(headFiles).run(), project(baseFiles).run());
  const fullMs = performance.now() - t;

  t = performance.now();
  const source = { mode: 'branch' as const, repo, project: projectRel, base: 'main', head: branch, files: diff.files };
  const head = project(headFiles);
  const base = project(baseFiles);
  const session = new LazySession(head, base, repo, config, diff, source, intent);
  session.init({ seedCount: 2 });
  let lazy = session.graph();
  const lazyMs = performance.now() - t;

  const check = (g: ModuleGraph, stage: string) => {
    for (const op of Object.values(g.operations)) {
      const f = full.operations[op.id];
      if (!f) { fail(`${stage}: ${op.id} not in full analysis`); continue; }
      if (op.change !== f.change) fail(`${stage}: ${op.id} change ${op.change} ≠ ${f.change}`);
      if (op.lazy?.calleesLoaded) {
        if (keys(op.effects) !== keys(f.effects)) fail(`${stage}: ${op.id} effects differ: ${keys(op.effects)} ≠ ${keys(f.effects)}`);
        if ((op.delta?.risk ?? 'none') !== (f.delta?.risk ?? 'none')) fail(`${stage}: ${op.id} risk ${op.delta?.risk} ≠ ${f.delta?.risk}`);
        if (JSON.stringify(op.changes ?? []) !== JSON.stringify(f.changes ?? [])) fail(`${stage}: ${op.id} code changes differ: lazy ${(op.changes ?? []).map((c) => c.name).join(', ')} ≠ full ${(f.changes ?? []).map((c) => c.name).join(', ')}`);
      }
    }
    for (const e of Object.values(g.entryPoints)) {
      const f = full.entryPoints[e.id];
      if (!f) { fail(`${stage}: entry ${e.id} not in full analysis`); continue; }
      if (e.analysis !== 'full') continue;
      if (e.change !== f.change) fail(`${stage}: ${e.id} change ${e.change} ≠ ${f.change}`);
      if (keys(e.effects) !== keys(f.effects)) fail(`${stage}: ${e.id} effects differ`);
      if (keys(e.effectsAdded ?? []) !== keys(f.effectsAdded ?? [])) fail(`${stage}: ${e.id} added effects differ`);
      if (e.containsChanges !== f.containsChanges) fail(`${stage}: ${e.id} containsChanges differs`);
    }
    if (Object.keys(g.entryPoints).length !== Object.keys(full.entryPoints).length) fail(`${stage}: entry point list incomplete`);
    // Lazy may fold less (callers not listed yet), never differently: every part it folds, full analysis folds there too.
    const fullChanges = reviewSummary(full, undefined).changes;
    const rootIn = new Map(fullChanges.flatMap((c) => [c.root, ...c.parts].map((id) => [id, c.root] as const)));
    for (const c of g.review.changes) for (const p of c.parts) if (rootIn.get(p) !== c.root) fail(`${stage}: lazy folds ${p} into ${c.root}, full analysis into ${rootIn.get(p)}`);
    console.log(`  ${stage}: ${g.review.changes.length} change(s) from ${g.review.queue.length} changed operations (full analysis: ${fullChanges.length})`);
  };

  const st = lazy.lazy!.stats;
  console.log(`  full: ${Object.keys(full.scopes).length} scopes in ${Math.round(fullMs)} ms`);
  console.log(`  lazy: ${Object.keys(lazy.scopes).length} scopes in ${Math.round(lazyMs)} ms · flows analyzed ${st.entryPointsAnalyzed}/${st.entryPointsKnown}, reached ${st.entryPointsReached}, ops ${st.operationsAnalyzed}/${st.operationsKnown}`);
  for (const s of lazy.lazy!.seeds) console.log(`  seed ${s.id} (${s.reason})`);
  // Two seeds, or every entry point that reaches the change when fewer do.
  const reaching = Object.values(full.entryPoints).filter((e) => e.containsChanges || e.change !== 'unchanged').length;
  if (lazy.lazy!.seeds.length !== Math.min(2, reaching)) fail(`expected ${Math.min(2, reaching)} seeds, got ${lazy.lazy!.seeds.length}`);
  if (st.entryPointsAnalyzed >= st.entryPointsKnown) fail('lazy analyzed every flow');
  check(lazy, 'initial');

  // Reviewer clicks: all entry points of the top change, then open a flow that was not a seed.
  const top = lazy.review.queue[0]?.operation;
  session.expand('reach', top);
  lazy = session.graph();
  const reachLazy = Object.values(lazy.entryPoints).filter((e) => e.analysis !== 'listed' && reaches(lazy, e.id, top)).length;
  const reachFull = Object.values(full.entryPoints).filter((e) => reaches(full as ModuleGraph, e.id, top)).length;
  console.log(`  after "all entry points" for ${top}: ${reachLazy} reach it (full analysis: ${reachFull})`);
  if (reachLazy !== reachFull) fail(`reach differs: ${reachLazy} ≠ ${reachFull}`);
  const other = Object.values(lazy.entryPoints).find((e) => e.analysis === 'reached');
  if (other) {
    session.expand('entry', other.id);
    lazy = session.graph();
    console.log(`  opened ${other.id}: now ${lazy.entryPoints[other.id].analysis}`);
    if (lazy.entryPoints[other.id].analysis !== 'full') fail('flow not analyzed after expand');
  }
  check(lazy, 'expanded');

  // Refresh with nothing changed: no file reported.
  const same = typescript.reopen!(head, { repo, projectDir, config, files: headFiles });
  if (same.changedFiles.length) fail(`refresh without edits reported ${same.changedFiles.join(', ')}`);

  // The reviewer fixes something locally and refreshes: only that file is re-read, the base is kept.
  const [file, find, replace] = fix;
  const abs = join(repo, file).replace(/\\/g, '/');
  const edited = new Map(headFiles);
  if (!edited.get(abs)?.includes(find)) { fail(`fix target not found in ${file}`); continue; }
  edited.set(abs, edited.get(abs)!.replace(find, replace));
  t = performance.now();
  const next = typescript.reopen!(same.analysis, { repo, projectDir, config, files: edited });
  const editedDiff = diffWithEdit(diff, file, headFiles.get(abs)!, find, replace);
  session.refresh({ head: next.analysis, base, diff: editedDiff, source, intent });
  lazy = session.graph();
  const refreshMs = performance.now() - t;
  full = compare(project(edited).run(), project(baseFiles).run());
  const st2 = lazy.lazy!.stats;
  console.log(`  refresh after editing ${file.split('/').pop()}: ${next.changedFiles.length} file re-read, ${Math.round(refreshMs)} ms · flows analyzed ${st2.entryPointsAnalyzed}, ops ${st2.operationsAnalyzed}`);
  if (next.changedFiles.length !== 1) fail(`refresh re-read ${next.changedFiles.length} files, expected 1`);
  if (st2.entryPointsAnalyzed < st.entryPointsAnalyzed) fail('refresh lost flows the reviewer had opened');
  check(lazy, 'refreshed');
}

/** The branch's diff plus a local edit, as `git diff <merge-base>` would show it (hunk positions from the edit). */
function diffWithEdit(diff: ReturnType<typeof diffBetween>, file: string, text: string, find: string, replace: string): ReturnType<typeof diffBetween> {
  const at = text.indexOf(find);
  const line = at < 0 ? 1 : text.slice(0, at).split('\n').length;
  const added = replace.split('\n').length;
  return { files: diff.files, patch: `${diff.patch}\ndiff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -${line},0 +${line},${added} @@\n` };
}

function reaches(g: ModuleGraph, scopeId: string, opId: string, seen = new Set<string>()): boolean {
  if (seen.has(scopeId)) return false;
  seen.add(scopeId);
  return (g.scopes[scopeId]?.steps ?? []).some((s) => s.target === opId || (!!s.target && reaches(g, s.target, opId, seen)));
}

console.log(failures ? `\n${failures} mismatch(es)` : '\nlazy analysis matches full analysis on everything it analyzed');
process.exit(failures ? 1 : 0);
