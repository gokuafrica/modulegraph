/**
 * Runs a scenario against a checked-out revision and records real inputs/outputs of every module operation.
 * Spawned by cli.ts (`--examples`) in its own process so module instances are fresh.
 * usage: node --import tsx examples-runner.ts <spec.json>
 *   spec: { scenario, projectRoot, out, targets: [{ opId, file, className, method, params }] }
 * The scenario lives outside the analyzed repo and exports `default (projectRoot: string) => Promise<void>`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Example } from '../../schema/modulegraph.ts';

interface Target {
  opId: string;
  file: string;
  className: string;
  method: string;
  params: string[];
}

const MAX_EXAMPLES = 3;
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { scenario: string; projectRoot: string; out: string; targets: Target[] };
const recorded = new Map<string, Example[]>();
const seen = new Set<string>();

/** JSON-safe, size-bounded copy so examples stay readable in a node. */
function snapshot(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return typeof value === 'string' && value.length > 120 ? `${value.slice(0, 117)}…` : value;
  }
  if (depth > 4) return Array.isArray(value) ? '[…]' : '{…}';
  if (Array.isArray(value)) {
    const items = value.slice(0, 5).map((v) => snapshot(v, depth + 1));
    return value.length > 5 ? [...items, `…${value.length - 5} more`] : items;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, snapshot(v, depth + 1)]));
}

function record(target: Target, args: unknown[], result: { output?: unknown; error?: string }) {
  const input = Object.fromEntries(target.params.map((name, i) => [name, snapshot(args[i])]));
  const example: Example = { input, ...(result.error ? { error: result.error } : { output: snapshot(result.output) }) };
  // Timestamps differ on every call; ignore them so "distinct" means a different case, not a later clock.
  const key = `${target.opId}|${JSON.stringify(example).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'T')}`;
  const list = recorded.get(target.opId) ?? [];
  if (seen.has(key) || list.length >= MAX_EXAMPLES) return;
  seen.add(key);
  recorded.set(target.opId, [...list, example]);
}

for (const target of spec.targets) {
  const mod = (await import(pathToFileURL(target.file).href)) as Record<string, any>;
  const cls = mod[target.className];
  const original = cls?.prototype?.[target.method];
  if (typeof original !== 'function') continue;
  cls.prototype[target.method] = function (this: unknown, ...args: unknown[]) {
    try {
      const out = original.apply(this, args);
      if (out && typeof out.then === 'function') {
        return out.then(
          (value: unknown) => (record(target, args, { output: value }), value),
          (err: unknown) => {
            record(target, args, { error: String(err) });
            throw err;
          },
        );
      }
      record(target, args, { output: out });
      return out;
    } catch (err) {
      record(target, args, { error: String(err) });
      throw err;
    }
  };
}

const scenario = (await import(pathToFileURL(spec.scenario).href)) as { default?: (projectRoot: string) => Promise<void> };
if (typeof scenario.default === 'function') await scenario.default(spec.projectRoot);

writeFileSync(spec.out, JSON.stringify(Object.fromEntries(recorded)));
console.log(`examples: ${recorded.size} operations covered`);
