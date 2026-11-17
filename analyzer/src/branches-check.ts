/**
 * The demo branches, before anything analyzes them (runs first in `npm test`):
 *   - every branch a check, demo or the UI check names is in scripts/demo-branches.json, the list setup creates local
 *     branches from (a branch missing from it works on the machine that made it and fails on every fresh clone);
 *   - every listed branch exists here (else: run `npm run setup`).
 * Branches a check makes itself (`checkout -b x`) don't count.
 * usage: npm run branches-check --workspace analyzer
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './git.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const listed: string[] = JSON.parse(readFileSync(join(repo, 'scripts/demo-branches.json'), 'utf8')).branches;
let failures = 0;

for (const file of readdirSync(here).filter((f) => f.endsWith('.ts'))) {
  const text = readFileSync(join(here, file), 'utf8');
  for (const [, name] of text.matchAll(/'((?:feature|fix)\/[\w.-]+)'/g)) {
    if (listed.includes(name) || new RegExp(`'-b',\\s*'${name.replace(/[.]/g, '[.]')}'`).test(text)) continue;
    console.log(`  ✖ ${file} uses branch ${name}, which scripts/demo-branches.json does not list: a fresh clone won't have it`);
    failures++;
  }
}
for (const name of listed) {
  try {
    git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`]);
  } catch {
    console.log(`  ✖ branch ${name} is missing here: run \`npm run setup\` (it creates the demo branches from origin/)`);
    failures++;
  }
}
console.log(failures ? `\n${failures} problem(s) with the demo branches` : `demo branches: all ${listed.length} listed and present`);
process.exit(failures ? 1 : 0);
