/**
 * Runs a scenario against a checked-out revision and records real inputs/outputs of every module operation.
 * Spawned by cli.ts (`--examples`) in its own process so module instances are fresh.
 * usage: node --import tsx examples-runner.ts <spec.json>
 *   spec: { scenario, projectRoot, out, targets: [{ opId, file, className, method, params }] }
 * The scenario lives outside the analyzed repo and exports
 * `default (projectRoot: string, { step }) => Promise<void>`.
 *
 * Examples are recorded per case: one request of the scenario (`step('GET /users/u-1/birth-info', fn)`), and
 * every module call made while serving it. A module deep in a flow therefore shows the call its caller made in
 * the same case, with the same data, so a reviewer can follow one request through every module. Calls made
 * outside a step start their own case at the outermost module call.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { Example, ExampleCase } from '../../schema/modulegraph.ts';

interface Target {
  opId: string;
  file: string;
  className: string;
  method: string;
  params: string[];
}

/** Distinct behaviours kept per operation (calls with the same input and output are one behaviour). */
const MAX_BEHAVIOURS = 12;
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { scenario: string; projectRoot: string; out: string; targets: Target[]; tsconfig?: string };

// Services that need decorator metadata (NestJS injection, TypeORM column types) are compiled by TypeScript.
if (spec.tsconfig && existsSync(spec.tsconfig)) {
  const read = ts.readConfigFile(spec.tsconfig, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dirname(spec.tsconfig));
  if (parsed.options.emitDecoratorMetadata) {
    const pkg = join(spec.projectRoot, 'package.json');
    const esm = existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { type?: string }).type === 'module';
    await import('reflect-metadata').catch(() => undefined);
    register('./ts-metadata-loader.mjs', import.meta.url, { data: { root: spec.projectRoot, options: parsed.options, esm } });
  }
}

interface Case extends ExampleCase {
  calls: Map<string, Example>;
}
const cases: Case[] = [];
const current = new AsyncLocalStorage<Case>();

/** JSON-safe, size-bounded copy so examples stay readable in a node. */
function snapshot(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return typeof value === 'string' && value.length > 120 ? `${value.slice(0, 117)}…` : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (depth > 4) return Array.isArray(value) ? '[…]' : '{…}';
  if (Array.isArray(value)) {
    const items = value.slice(0, 5).map((v) => snapshot(v, depth + 1));
    return value.length > 5 ? [...items, `…${value.length - 5} more`] : items;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, snapshot(v, depth + 1)]));
}

function newCase(label: string): Case {
  const c: Case = { id: `c${cases.length + 1}`, label, calls: new Map() };
  cases.push(c);
  return c;
}

/** Short text for an argument list: `u-2`, `u-2, "GBR"`. */
function argLabel(args: unknown[]): string {
  const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(', ');
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** An error as the example shows it, with the HTTP status when the error carries one (NestJS, http-errors). */
function failure(err: unknown): { error: string; status?: number } {
  const e = err as { getStatus?: () => unknown; status?: unknown; statusCode?: unknown };
  const status = typeof e?.getStatus === 'function' ? e.getStatus() : e?.status ?? e?.statusCode;
  return { error: String(err), ...(typeof status === 'number' ? { status } : {}) };
}

function record(c: Case, target: Target, args: unknown[], result: { output?: unknown; error?: string; status?: number }) {
  // An operation called several times in one case (a loop) shows its first call.
  if (c.calls.has(target.opId)) return;
  const input = Object.fromEntries(target.params.map((name, i) => [name, snapshot(args[i])]));
  c.calls.set(target.opId, { input, ...(result.error ? { error: result.error, ...(result.status ? { status: result.status } : {}) } : { output: snapshot(result.output) }) });
}

for (const target of spec.targets) {
  const mod = (await import(pathToFileURL(target.file).href)) as Record<string, any>;
  const cls = mod[target.className];
  const original = cls?.prototype?.[target.method];
  if (typeof original !== 'function') continue;
  cls.prototype[target.method] = function (this: unknown, ...args: unknown[]) {
    const inCase = current.getStore();
    const c = inCase ?? newCase(`${target.className}.${target.method}(${argLabel(args)})`);
    const run = () => {
      try {
        const out = original.apply(this, args);
        if (out && typeof out.then === 'function') {
          return out.then(
            (value: unknown) => (record(c, target, args, { output: value }), value),
            (err: unknown) => {
              record(c, target, args, failure(err));
              throw err;
            },
          );
        }
        record(c, target, args, { output: out });
        return out;
      } catch (err) {
        record(c, target, args, failure(err));
        throw err;
      }
    };
    return inCase ? run() : current.run(c, run);
  };
}

/** One case per request: every module call made inside `fn` belongs to it. Errors are recorded, not thrown. */
async function step<T>(label: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await current.run(newCase(label), fn);
  } catch {
    return undefined;
  }
}

const scenario = (await import(pathToFileURL(spec.scenario).href)) as {
  default?: (projectRoot: string, ctx: { step: typeof step }) => Promise<void>;
};
if (typeof scenario.default === 'function') await scenario.default(spec.projectRoot, { step });

// One example per distinct behaviour of an operation (its input and output), listing every case it happened in.
// So whichever case the reviewer follows, each module that case reached shows the call it got in that case.
const normal = (e: Example) => JSON.stringify({ ...e, cases: undefined }).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'T');
const examples: Record<string, Example[]> = {};
const byBehaviour = new Map<string, Example>();
for (const c of cases) {
  for (const [opId, e] of c.calls) {
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
const usedCases = cases.filter((c) => c.calls.size);
writeFileSync(spec.out, JSON.stringify({ examples, cases: usedCases.map(({ id, label }) => ({ id, label })) }));
console.log(`examples: ${Object.keys(examples).length} operations, ${usedCases.length} cases`);
