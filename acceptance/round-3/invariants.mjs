#!/usr/bin/env node
/**
 * Invariants that must hold for ANY review modulegraph writes, on any service. No fixture or service names in here:
 * these are properties of a correct review, not expectations about one codebase.
 *
 *   node invariants.mjs <review.json> [--project <service dir>]
 *
 * Exit 0 when all hold. With --project, the service's route decorators are also counted (I5).
 * Used by accept-r3.mjs on every run, and meant to be run by modulegraph's own tests on every sample it has.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

/** A target that is code, not a name: an unresolved marker, a raw expression, or a method name standing in for a value. */
export const RAW_TARGET = /^\?$|^$|[<>()`]|\{(get|getOrThrow|getOrDefault)\}|\bthis\.|\bparameters?\.|\bconfigService\b|undefined/;

export function invariants(g, projectDir) {
  const out = [];
  const add = (id, what, bad) => out.push({ id, what, pass: !bad.length, detail: bad.slice(0, 12).join(' | ') + (bad.length > 12 ? ` | … ${bad.length - 12} more` : '') });
  const entries = Object.values(g.entryPoints ?? {});
  const effects = [
    ...Object.values(g.operations ?? {}).flatMap((o) => [...(o.directEffects ?? []), ...(o.effects ?? [])].map((f) => ({ f, where: o.id }))),
    ...entries.flatMap((e) => (e.effects ?? []).map((f) => ({ f, where: e.id }))),
  ];

  // I1. Every side effect names what it touches.
  add('I1', 'every effect target is a name (table, topic, event type, host or URL template), never code or "?"',
    [...new Set(effects.filter(({ f }) => RAW_TARGET.test(f.target ?? '')).map(({ f, where }) => `${f.kind} ${f.target} (${where}${f.file ? ` ${f.file}:${f.line}` : ''})`))]);

  // I2. One entry point per registered thing: a job or a consumer key is one entry point, whatever methods run it.
  const keyOf = (e) => e.label.replace(/\s*\([^)]*\)\s*$/, '');
  const byKey = new Map();
  for (const e of entries) byKey.set(`${e.kind} ${keyOf(e)}`, [...(byKey.get(`${e.kind} ${keyOf(e)}`) ?? []), e.label]);
  add('I2', 'one entry point per job / consumer / route (no key listed twice)', [...byKey.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => `${k}: ${v.join(', ')}`));

  // I3. Entry points have real labels.
  add('I3', 'no entry point label is unknown ("?", "undefined", "<…>")', entries.filter((e) => /\?|undefined|<[^>]*>/.test(e.label)).map((e) => `${e.kind} ${e.label} (${e.file}:${e.line})`));

  // I4. Steps that are effects carry their effect.
  const badSteps = [];
  for (const [id, s] of Object.entries(g.scopes ?? {})) for (const st of s.steps ?? []) if (st.kind === 'effect' && (!st.effect || RAW_TARGET.test(st.effect.target ?? ''))) badSteps.push(`${id}: ${st.effect ? `${st.effect.kind} ${st.effect.target}` : 'no effect'} (${st.file}:${st.line})`);
  add('I4', 'every effect step in every flow names its target', [...new Set(badSteps)]);

  // I7. Everything flagged can be acted on: each package an unknown-side-effects item names appears in its suggestion
  // (a sink rule, or a coverage.ignore line). A flag you can't act on only stays.
  const unacted = [];
  for (const i of g.incomplete ?? []) {
    if (i.kind !== 'unknown-side-effects') continue;
    for (const item of i.items ?? []) {
      const pkg = /^(@?[^\s(:]+)/.exec(item)?.[1];
      if (pkg && !(i.suggestion ?? '').includes(`"${pkg}"`)) unacted.push(`${pkg}: flagged, but the suggestion has no rule for it`);
    }
  }
  add('I7', 'every flagged package comes with a suggested rule (sink or coverage.ignore)', unacted);

  // I9. Gaps are structured: every operation gap has a file, a line and a reason from the closed list.
  const REASONS = new Set(['function-value', 'interface-dispatch', 'untyped', 'dynamic']);
  const badGaps = Object.values(g.operations ?? {}).flatMap((o) => (o.gaps ?? []).filter((x) => !x.file || !x.line || !REASONS.has(x.reason)).map((x) => `${o.id}: ${JSON.stringify(x)}`));
  add('I9', 'every gap names its file, line and a reason from the closed list', badGaps);

  // I5. HTTP routes in the source = api entry points (only with --project).
  if (projectDir) {
    const files = [];
    const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n === 'node_modules' || n.startsWith('.')) continue; if (statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(n) && !/\.(spec|test)\.ts$/.test(n)) files.push(p); } };
    walk(join(projectDir, 'src'));
    const routes = files.reduce((n, f) => n + (readFileSync(f, 'utf8').match(/@(Get|Post|Put|Patch|Delete|All)\(/g) ?? []).length, 0);
    const apis = entries.filter((e) => e.kind === 'api').length;
    add('I5', `api entry points = route decorators in src (${apis} / ${routes})`, apis === routes ? [] : [`${apis} api entry points, ${routes} route decorators`]);

  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { project: { type: 'string' } } });
  if (!positionals[0]) {
    console.error('usage: node invariants.mjs <review.json> [--project <service dir>]');
    process.exit(2);
  }
  const res = invariants(JSON.parse(readFileSync(positionals[0], 'utf8')), values.project);
  for (const r of res) console.log(`  ${r.pass ? '✓' : '✖'} [${r.id}] ${r.what}${r.pass ? '' : `\n        got: ${r.detail}`}`);
  process.exit(res.every((r) => r.pass) ? 0 : 1);
}
