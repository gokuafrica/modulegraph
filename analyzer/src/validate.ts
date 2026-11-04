/**
 * Validates modulegraph JSON files against schema/modulegraph.schema.json, plus referential integrity
 * (every step target, scope and module reference resolves). Used for agent-written graphs.
 * usage: tsx src/validate.ts <file.json>...
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleGraph } from '../../schema/modulegraph.ts';

type Schema = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const root: Schema = JSON.parse(readFileSync(resolve(here, '../../schema/modulegraph.schema.json'), 'utf8'));

function check(value: unknown, schema: Schema, path: string, errors: string[]): void {
  if (errors.length > 20) return;
  if (schema.$ref) return check(value, root.definitions[schema.$ref.split('/').pop()], path, errors);
  if (schema.allOf) return schema.allOf.forEach((s: Schema) => check(value, s, path, errors));
  if (schema.anyOf) {
    if (!schema.anyOf.some((s: Schema) => { const e: string[] = []; check(value, s, path, e); return e.length === 0; })) errors.push(`${path}: matches no alternative`);
    return;
  }
  if ('const' in schema && value !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in ${schema.enum.join('|')}`);
  if (schema.type === 'string' && typeof value !== 'string') errors.push(`${path}: expected string`);
  if (schema.type === 'number' && typeof value !== 'number') errors.push(`${path}: expected number`);
  if (schema.type === 'boolean' && typeof value !== 'boolean') errors.push(`${path}: expected boolean`);
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return void errors.push(`${path}: expected array`);
    value.forEach((v, i) => check(v, schema.items ?? {}, `${path}[${i}]`, errors));
  }
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return void errors.push(`${path}: expected object`);
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${path}.${key}: required`);
    for (const [key, v] of Object.entries(obj)) {
      if (schema.properties?.[key]) check(v, schema.properties[key], `${path}.${key}`, errors);
      else if (typeof schema.additionalProperties === 'object') check(v, schema.additionalProperties, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unknown property`);
    }
  }
}

function integrity(g: ModuleGraph, errors: string[]): void {
  for (const op of Object.values(g.operations)) {
    if (!g.modules[op.moduleId]) errors.push(`operation ${op.id}: unknown module ${op.moduleId}`);
    if (!g.scopes[op.id]) errors.push(`operation ${op.id}: no scope`);
    for (const c of op.calls) if (!g.lazy && !g.operations[c]) errors.push(`operation ${op.id}: calls unknown ${c}`);
  }
  // Lazy graphs list entry points before analyzing them, and steps may target operations not analyzed yet.
  for (const e of Object.values(g.entryPoints)) if (!g.scopes[e.id] && !(g.lazy && e.analysis === 'listed')) errors.push(`entry ${e.id}: no scope`);
  for (const scope of Object.values(g.scopes)) {
    const ids = new Set(['entry', 'exit', ...scope.steps.map((s) => s.id)]);
    for (const s of scope.steps) if (s.kind === 'call' && !g.lazy && !g.operations[s.target!]) errors.push(`scope ${scope.id}: step ${s.id} targets unknown ${s.target}`);
    for (const e of scope.edges) if (!ids.has(e.from) || !ids.has(e.to)) errors.push(`scope ${scope.id}: edge ${e.from}->${e.to} dangles`);
  }
}

let failed = false;
for (const file of process.argv.slice(2)) {
  const graph = JSON.parse(readFileSync(file, 'utf8')) as ModuleGraph;
  const errors: string[] = [];
  check(graph, root, '$', errors);
  if (!errors.length) integrity(graph, errors);
  console.log(errors.length ? `✖ ${file}\n  ${errors.slice(0, 20).join('\n  ')}` : `✓ ${file}`);
  failed ||= errors.length > 0;
}
process.exit(failed ? 1 : 0);
