import type { Example, ExampleCase } from '../../schema/modulegraph.ts';

/** Distinct behaviours kept per operation (calls with the same input and output are one behaviour). */
export const MAX_BEHAVIOURS = 12;

/** One recorded case (a scenario request, or a test) and the first call each operation got in it. */
export interface RecordedCase extends ExampleCase {
  calls: Map<string, Example> | Record<string, Example>;
}

/**
 * One example per distinct behaviour of an operation (its input and output), listing every case it happened in.
 * So whichever case the reviewer follows, each module that case reached shows the call it got in that case.
 */
export function examplesFromCases(cases: RecordedCase[]): { examples: Record<string, Example[]>; cases: ExampleCase[] } {
  const normal = (e: Example) => JSON.stringify({ ...e, cases: undefined }).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'T');
  const examples: Record<string, Example[]> = {};
  const byBehaviour = new Map<string, Example>();
  const used: ExampleCase[] = [];
  for (const c of cases) {
    const calls = c.calls instanceof Map ? [...c.calls] : Object.entries(c.calls);
    if (!calls.length) continue;
    used.push({ id: c.id, label: c.label });
    for (const [opId, e] of calls) {
      const key = `${opId}|${normal(e)}`;
      const known = byBehaviour.get(key);
      if (known) {
        known.cases!.push(c.id);
        continue;
      }
      const list = (examples[opId] ??= []);
      if (list.length >= MAX_BEHAVIOURS) continue;
      const kept = { ...e, cases: [c.id] };
      byBehaviour.set(key, kept);
      list.push(kept);
    }
  }
  return { examples, cases: used };
}
