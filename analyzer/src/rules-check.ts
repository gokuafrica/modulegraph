/**
 * Rule tests on small hand-built graphs: each rule must fire on the cases it is for and stay quiet on the near
 * misses (the false positives a reviewer would otherwise learn to ignore). Add a case whenever a rule changes.
 */
import type { Edge, Effect, Operation, Step } from '../../schema/modulegraph.ts';
import type { Graphish } from './compare.ts';
import { repeatReads } from './rules.ts';

const read = (table: string): Effect => ({ kind: 'db.read', target: table });
const write = (table: string): Effect => ({ kind: 'db.write', target: table });

/** One orchestrating operation `Svc.run` whose steps call modules with the given effects. */
function graph(calls: { op: string; effects: Effect[]; input?: string; condition?: string; loop?: boolean }[], extraEdges: Edge[] = []): Graphish {
  const op = (id: string, effects: Effect[]): Operation => ({
    id, moduleId: id.split('.')[0], name: id.split('.')[1], file: 'x.ts', line: 1, endLine: 1, params: [], returns: { type: 'void' },
    directEffects: [], effects, calls: [], change: 'unchanged', containsChanges: false, source: '',
  });
  const steps: Step[] = calls.map((c, i) => ({ id: `s${i + 1}`, kind: 'call', target: c.op, line: i + 1, file: 'x.ts', condition: c.condition, loop: c.loop }));
  const edges: Edge[] = [
    ...calls.flatMap((c, i) => (c.input ? [{ from: c.input.split(':')[0], to: `s${i + 1}`, kind: 'data' as const, label: c.input.split(':')[1] }] : [])),
    ...extraEdges,
  ];
  const ops = Object.fromEntries([op('Svc.run', []), ...calls.map((c) => op(c.op, c.effects))].map((o) => [o.id, o]));
  const modules = Object.fromEntries([...new Set(Object.values(ops).map((o) => o.moduleId))].map((m) => [m, { id: m, name: m, className: m, file: 'x.ts', line: 1, summary: '', declaredEffects: [], operations: [], change: 'unchanged' }]));
  return { modules, operations: ops, entryPoints: {}, scopes: { 'Svc.run': { id: 'Svc.run', params: [], steps, edges } } } as unknown as Graphish;
}

const cases: [string, Graphish, number][] = [
  ['same table, same input, nothing in between', graph([
    { op: 'Docs.forUser', effects: [read('documents')], input: 'entry:userId' },
    { op: 'View.get', effects: [read('documents'), read('kyc')], input: 'entry:userId' },
  ]), 1],
  ['different inputs (another row)', graph([
    { op: 'Docs.forUser', effects: [read('documents')], input: 'entry:userId' },
    { op: 'Docs.forUser2', effects: [read('documents')], input: 'entry:otherUserId' },
  ]), 0],
  ['re-read after a write to the table (fresh data)', graph([
    { op: 'Kyc.find', effects: [read('kyc')], input: 'entry:userId' },
    { op: 'Kyc.save', effects: [write('kyc')], input: 'entry:userId' },
    { op: 'View.get', effects: [read('kyc')], input: 'entry:userId' },
  ]), 0],
  ['exclusive branches (only one runs)', graph([
    { op: 'Docs.forUser', effects: [read('documents')], input: 'entry:userId', condition: 'if (consented)' },
    { op: 'Docs.forUser2', effects: [read('documents')], input: 'entry:userId', condition: 'unless (consented)' },
  ]), 0],
  ['in a loop (per item, not a repeat)', graph([
    { op: 'Docs.forUser', effects: [read('documents')], input: 'entry:userId' },
    { op: 'Docs.forUser2', effects: [read('documents')], input: 'entry:userId', loop: true },
  ]), 0],
  ['different tables', graph([
    { op: 'Docs.forUser', effects: [read('documents')], input: 'entry:userId' },
    { op: 'Kyc.find', effects: [read('kyc')], input: 'entry:userId' },
  ]), 0],
];

let bad = 0;
for (const [name, g, want] of cases) {
  const got = repeatReads(g).length;
  if (got !== want) {
    bad++;
    console.log(`FAIL repeat-read: ${name}: expected ${want} finding(s), got ${got}`);
  }
}
console.log(bad ? `rules: ${bad} failed` : `rules: all ${cases.length} cases pass`);
process.exit(bad ? 1 : 0);
