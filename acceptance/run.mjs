#!/usr/bin/env node
/**
 * Runs a round of the testers' acceptance check (acceptance/round-<n>, written by the testers, not by modulegraph's
 * authors) on this checkout:
 *   1. makes that round's fixture service in the OS temp folder if it isn't there yet (outside any repo, its own
 *      `npm install`: a fixture inside modulegraph's workspaces would hide the Jest resolution bug round 2 tests);
 *   2. runs accept-r<n>.mjs with --ui (an installed Edge or Chrome; without one the UI checks fail).
 * Extra arguments go to accept-r<n>.mjs, e.g. `--fresh-clone https://github.com/<owner>/modulegraph.git` once main is
 * pushed. Exit code: accept-r<n>.mjs's (0 only when every check passes).
 *
 *   node acceptance/run.mjs <n> [--fresh-clone <git url>] [--keep]     (npm run accept:r3 / accept:r4)
 *   MODULEGRAPH_R<n>_FIXTURE=<dir>   use (or make) the fixture there instead
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [round, ...rest] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const kit = join(here, `round-${round}`);
if (!/^\d+$/.test(round ?? '') || !existsSync(kit)) {
  console.error('usage: node acceptance/run.mjs <round> [args for accept-r<round>.mjs]');
  process.exit(2);
}
const fixture = resolve(process.env[`MODULEGRAPH_R${round}_FIXTURE`] ?? join(tmpdir(), `modulegraph-r${round}`, 'records-review-service'));

if (!existsSync(join(fixture, 'node_modules'))) {
  if (existsSync(fixture)) {
    console.error(`${fixture} exists but has no node_modules: delete it (the fixture script won't overwrite) and run again`);
    process.exit(2);
  }
  console.log(`making the fixture in ${fixture} (git repo + npm install, about a minute)`);
  const made = spawnSync(process.execPath, [join(kit, `create-r${round}-fixture.mjs`), fixture], { stdio: 'inherit' });
  if (made.status !== 0) process.exit(made.status ?? 1);
}
const run = spawnSync(process.execPath, [join(kit, `accept-r${round}.mjs`), '--modulegraph', repo, '--fixture', fixture, '--ui', ...rest], { stdio: 'inherit' });
process.exit(run.status ?? 1);
