/**
 * Checks how changed operations fold into changes: a changed operation is part of another one only when every path
 * to it passes through that one. Small hand-built call graphs for each case, then the birth-info demo, where the
 * new verifier and the store change sit inside updateKycBirthInfo and are one change.
 * usage: npx tsx src/changes-check.ts (part of npm test)
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReviewChange, Risk } from '../../schema/modulegraph.ts';
import { typescript } from './analyzers/typescript/index.ts';
import { compare, type Graphish } from './compare.ts';
import { loadConfig } from './config.ts';
import { diffBetween, filesAtRef, mergeBase, revParse } from './git.ts';
import { LazySession } from './lazy.ts';
import { changeGroups, reviewSummary } from './rules.ts';

let failures = 0;
const expect = (name: string, got: unknown, want: unknown) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  console.log(`  ${a === b ? '✓' : '✖'} ${name}${a === b ? '' : `\n      got  ${a}\n      want ${b}`}`);
  if (a !== b) failures++;
};

/** A call graph: `calls` maps a scope (entry point or operation) to what it calls; `changed` gives each changed op's risk. */
function graph(calls: Record<string, string[]>, changed: Record<string, Risk>, opts: { removed?: Record<string, string[]>; callersUnknown?: string[] } = {}) {
  const ids = new Set([...Object.keys(calls), ...Object.values(calls).flat(), ...Object.values(opts.removed ?? {}).flat()]);
  const g = { modules: {}, operations: {}, entryPoints: {}, scopes: {} } as unknown as Graphish;
  for (const id of ids) {
    const steps = (calls[id] ?? []).map((target) => ({ target }));
    const removedSteps = (opts.removed?.[id] ?? []).map((target) => ({ target }));
    (g.scopes as Record<string, unknown>)[id] = { steps, ...(removedSteps.length ? { removedSteps } : {}) };
    if (id.startsWith('api:')) (g.entryPoints as Record<string, unknown>)[id] = { id, change: 'unchanged' };
    else {
      (g.operations as Record<string, unknown>)[id] = {
        id, change: changed[id] ? 'modified' : 'unchanged',
        ...(opts.callersUnknown ? { lazy: { callersLoaded: !opts.callersUnknown.includes(id), calleesLoaded: true } } : {}),
      };
    }
  }
  const queue = Object.entries(changed).map(([operation, risk]) => ({ operation, risk, reason: '', reach: 1 }));
  return changeGroups(g, queue);
}
const shape = (cs: ReviewChange[]) => cs.map((c) => ({ root: c.root, parts: c.parts, risk: c.risk, ...(c.alsoIn ? { alsoIn: c.alsoIn } : {}) }));

console.log('\nfolding changed operations into changes');
expect('callees reached only through a changed caller are parts of its change, and its risk is the highest of them',
  shape(graph({ 'api:A': ['svc'], svc: ['verify', 'store'] }, { verify: 'high', store: 'high', svc: 'medium' })),
  [{ root: 'svc', parts: ['verify', 'store'], risk: 'high' }]);
expect('an unchanged module in between does not split the change',
  shape(graph({ 'api:A': ['svc'], svc: ['helper'], helper: ['store'] }, { svc: 'low', store: 'medium' })),
  [{ root: 'svc', parts: ['store'], risk: 'medium' }]);
expect('a shared module another flow reaches without the changed caller stays its own change',
  shape(graph({ 'api:A': ['svc'], 'api:B': ['other'], svc: ['shared'], other: ['shared'] }, { svc: 'medium', shared: 'high' })),
  [{ root: 'shared', parts: [], risk: 'high', alsoIn: ['svc'] }, { root: 'svc', parts: [], risk: 'medium' }]);
expect('unrelated changes stay separate',
  shape(graph({ 'api:A': ['a'], 'api:B': ['b'] }, { a: 'low', b: 'low' })),
  [{ root: 'a', parts: [], risk: 'low' }, { root: 'b', parts: [], risk: 'low' }]);
expect('nested changes go to the topmost one',
  shape(graph({ 'api:A': ['top'], top: ['mid'], mid: ['leaf'] }, { top: 'low', mid: 'low', leaf: 'high' })),
  [{ root: 'top', parts: ['mid', 'leaf'], risk: 'high' }]);
expect('two changed callers that both lead to it: neither owns it',
  shape(graph({ 'api:A': ['a'], 'api:B': ['b'], a: ['x'], b: ['x'] }, { a: 'low', b: 'low', x: 'medium' })),
  [{ root: 'x', parts: [], risk: 'medium', alsoIn: ['a', 'b'] }, { root: 'a', parts: [], risk: 'low' }, { root: 'b', parts: [], risk: 'low' }]);
expect('a removed call folds the removed operation into the caller that dropped it',
  shape(graph({ 'api:A': ['svc'] }, { svc: 'low', old: 'high' }, { removed: { svc: ['old'] } })),
  [{ root: 'svc', parts: ['old'], risk: 'high' }]);
expect('lazy: an operation whose callers were never listed is not folded on a guess',
  shape(graph({ 'api:A': ['svc'], svc: ['store'] }, { svc: 'medium', store: 'high' }, { callersUnknown: ['store'] })),
  [{ root: 'store', parts: [], risk: 'high', alsoIn: ['svc'] }, { root: 'svc', parts: [], risk: 'medium' }]);
expect('lazy: once its callers are listed, it folds',
  shape(graph({ 'api:A': ['svc'], svc: ['store'] }, { svc: 'medium', store: 'high' }, { callersUnknown: [] })),
  [{ root: 'svc', parts: ['store'], risk: 'high' }]);

// The birth-info demo, analyzed from git like a review.
console.log('\nbirth-info demo: feature/enforce-document-birth-info vs main');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..').replace(/\\/g, '/');
const projectRel = 'sample-birth-service';
const projectDir = join(repo, projectRel).replace(/\\/g, '/');
const config = loadConfig(projectDir, join(repo, 'configs/birth-info-service/modulegraph.config.json'));
const branch = 'feature/enforce-document-birth-info';
const open = (ref: string) => typescript.open({ repo, projectDir, config, files: filesAtRef(repo, ref, projectRel) }).run();
const g = compare(open(revParse(repo, branch)), open(mergeBase(repo, 'main', branch)));
const review = reviewSummary(g, undefined);
expect('one change, starting at updateKycBirthInfo, with the verifier and the store inside',
  shape(review.changes).map((c) => ({ ...c, parts: [...c.parts].sort() })),
  [{ root: 'BirthInfoService.updateKycBirthInfo', parts: ['BirthInfoVerifier.verify', 'KycBirthInfoStore.save'], risk: 'high' }]);
expect('every changed operation is in exactly one change',
  review.changes.flatMap((c) => [c.root, ...c.parts]).sort(), review.queue.map((q) => q.operation).sort());

// A new area with two new APIs: they fill the lazy seeds before the caller search runs, which must not stop the
// store calls folding into the operations that use them.
console.log('\nresidency: feature/residency-declaration vs feature/enforce-document-birth-info, full and lazy');
const head = 'feature/residency-declaration';
const prev = 'feature/enforce-document-birth-info';
const want = [
  { root: 'ResidencyService.get', parts: ['ResidencyStore.count', 'ResidencyStore.latest'], risk: 'high', alsoIn: ['ResidencyService.declare'] },
  { root: 'ResidencyService.declare', parts: ['AddressCheckClient.verify', 'ResidencyStore.add'], risk: 'high' },
];
const sorted = (cs: ReviewChange[]) => shape(cs).map((c) => ({ ...c, parts: [...c.parts].sort() }));
const mb = mergeBase(repo, prev, head);
const headFiles = filesAtRef(repo, revParse(repo, head), projectRel);
const baseFiles = filesAtRef(repo, mb, projectRel);
const project = (files: Map<string, string>) => typescript.open({ repo, projectDir, config, files });
expect('full: the read and the declaration, each with its store and service calls inside',
  sorted(reviewSummary(compare(project(headFiles).run(), project(baseFiles).run()), undefined).changes), want);
const diff = diffBetween(repo, mb, head, projectRel);
const session = new LazySession(project(headFiles), project(baseFiles), repo, config, diff,
  { mode: 'branch', repo, project: projectRel, base: prev, head, files: diff.files }, 'Residency');
session.init({ seedCount: 2 });
expect('lazy: the same two changes', sorted(session.graph().review.changes), want);

console.log(failures ? `\n${failures} failure(s)` : '\nchanges fold as expected');
process.exit(failures ? 1 : 0);
