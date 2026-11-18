/**
 * modulegraph explain <id> [<Class.method>]: what the analysis did with every call of an operation, for a person
 * (the same as <id>.explain.json, which `analyze --explain` writes next to the review). No operation: the operations
 * with gaps. This is what to attach to a bug note, with the code it is about.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExplainEntry, ModuleGraph } from '../../schema/modulegraph.ts';
import { userReviewsDir } from './home.ts';

const [id, op] = process.argv.slice(2);
if (!id || id.startsWith('-')) {
  console.error('usage: modulegraph explain <review id> [<Class.method>]');
  process.exit(2);
}
const dir = existsSync(id) ? undefined : userReviewsDir;
const base = dir ? join(dir, id) : id.replace(/(\.explain)?\.json$/, '');
const file = `${base}.explain.json`;
if (!existsSync(file)) {
  console.error(`no ${file}: analyze the change again with --explain (modulegraph analyze … --explain)`);
  process.exit(2);
}
const explain = JSON.parse(readFileSync(file, 'utf8')) as Record<string, ExplainEntry[]>;
const graph = existsSync(`${base}.json`) ? (JSON.parse(readFileSync(`${base}.json`, 'utf8')) as ModuleGraph) : undefined;

const WHAT: Record<ExplainEntry['disposition'], string> = {
  step: 'step     ',
  inlined: 'inlined  ',
  external: 'external ',
  followed: 'followed ',
  gap: 'GAP      ',
};

function show(key: string): void {
  const entries = explain[key];
  const gaps = graph?.operations[key]?.gaps ?? graph?.entryPoints[key]?.gaps ?? [];
  console.log(`\n${key}: ${entries.length} calls${gaps.length ? `, ${gaps.length} gap${gaps.length > 1 ? 's' : ''}` : ', no gap'}`);
  for (const e of entries) {
    // A target in the same file is its line.
    const to = e.to?.split(', ').map((t) => (t.startsWith(`${e.file}:`) ? `line ${t.slice(e.file.length + 1)}` : t)).join(', ');
    const detail = e.disposition === 'gap' ? ` (${e.reason})` : to ? ` → ${to}` : '';
    console.log(`  ${e.file}:${String(e.line).padEnd(5)} ${WHAT[e.disposition]} ${e.text}${detail}`);
  }
}

if (op) {
  const keys = Object.keys(explain).filter((k) => k === op || k.endsWith(`:${op}`) || k.toLowerCase().includes(op.toLowerCase()));
  if (!keys.length) {
    console.error(`${op} is not in this review's analysis (${Object.keys(explain).length} operations and entry points are)`);
    process.exit(1);
  }
  for (const k of keys.includes(op) ? [op] : keys) show(k);
} else {
  const withGaps = Object.keys(explain).filter((k) => explain[k].some((e) => e.disposition === 'gap'));
  console.log(`${Object.keys(explain).length} operations and entry points analyzed; ${withGaps.length} with gaps${withGaps.length ? ':' : ''}`);
  for (const k of withGaps) show(k);
}
