/**
 * Checks that lazy analysis agrees with full analysis on everything it has analyzed, and that it really
 * analyzed less. Runs both on the demo branches, then expands the lazy graph the way a reviewer would.
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

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..').replace(/\\/g, '/');

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  ✖ ${msg}`);
};
const keys = (es: { kind: string; target: string }[]) => es.map((e) => effectKey(e as never)).sort().join(', ');

for (const [projectRel, profile, branch, intent] of [
  ['sample-service', 'identity-profile-service', 'feature/birthinfo-consent', 'BirthInfo: prefer user-consented birth data over document data; add consent endpoint.'],
  ['sample-service', 'identity-profile-service', 'feature/kyc-risk-tiers', 'KYC: risk tiers, manual review, async nightly rescreen.'],
  // NestJS: decorator entry points, framework sinks, constructor injection through @Inject* decorators
  ['sample-nest-service', 'order-service', 'feature/order-fraud-hold', 'Orders: hold high-risk orders for fraud review; release endpoint; fraud desk decisions; loyalty discounts; carrier status from events.'],
] as const) {
  console.log(`\n${projectRel} ${branch}`);
  const projectDir = join(repo, projectRel).replace(/\\/g, '/');
  const config = loadConfig(projectDir, join(repo, `configs/${profile}/modulegraph.config.json`));
  const project = (files: Map<string, string>) => typescript.open({ repo, projectDir, config, files });
  const mb = mergeBase(repo, 'main', branch);
  const headFiles = filesAtRef(repo, revParse(repo, branch), projectRel);
  const baseFiles = filesAtRef(repo, mb, projectRel);
  const diff = diffBetween(repo, mb, branch, projectRel);

  let t = performance.now();
  const full = compare(project(headFiles).run(), project(baseFiles).run());
  const fullMs = performance.now() - t;

  t = performance.now();
  const source = { mode: 'branch' as const, repo, project: projectRel, base: 'main', head: branch, files: diff.files };
  const session = new LazySession(project(headFiles), project(baseFiles), repo, config, diff, source, intent);
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
  };

  const st = lazy.lazy!.stats;
  console.log(`  full: ${Object.keys(full.scopes).length} scopes in ${Math.round(fullMs)} ms`);
  console.log(`  lazy: ${Object.keys(lazy.scopes).length} scopes in ${Math.round(lazyMs)} ms · flows analyzed ${st.entryPointsAnalyzed}/${st.entryPointsKnown}, reached ${st.entryPointsReached}, ops ${st.operationsAnalyzed}/${st.operationsKnown}`);
  for (const s of lazy.lazy!.seeds) console.log(`  seed ${s.id} (${s.reason})`);
  if (lazy.lazy!.seeds.length !== 2) fail('expected 2 seeds');
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
}

function reaches(g: ModuleGraph, scopeId: string, opId: string, seen = new Set<string>()): boolean {
  if (seen.has(scopeId)) return false;
  seen.add(scopeId);
  return (g.scopes[scopeId]?.steps ?? []).some((s) => s.target === opId || (!!s.target && reaches(g, s.target, opId, seen)));
}

console.log(failures ? `\n${failures} mismatch(es)` : '\nlazy analysis matches full analysis on everything it analyzed');
process.exit(failures ? 1 : 0);
