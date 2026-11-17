#!/usr/bin/env node
/**
 * Runs the round-2 acceptance check (acceptance/round-2, written by the testers, not by modulegraph's authors) on
 * this checkout:
 *   1. makes the fixture service in the OS temp folder if it isn't there yet (outside any repo, its own
 *      `npm install`: a fixture inside modulegraph's workspaces would hide the Jest resolution bug it tests);
 *   2. runs accept-r2.mjs with --ui (an installed Edge or Chrome; without one the UI checks fail).
 * Extra arguments go to accept-r2.mjs, e.g. `--fresh-clone https://github.com/<owner>/modulegraph.git` once main is
 * pushed. Exit code: accept-r2.mjs's (0 only when every check passes).
 *
 *   npm run accept:r2 [-- --fresh-clone <git url>] [-- --keep]
 *   MODULEGRAPH_R2_FIXTURE=<dir>   use (or make) the fixture there instead
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const kit = join(here, 'round-2');
const fixture = resolve(process.env.MODULEGRAPH_R2_FIXTURE ?? join(tmpdir(), 'modulegraph-r2', 'records-review-service'));

if (!existsSync(join(fixture, 'node_modules'))) {
  if (existsSync(fixture)) {
    console.error(`${fixture} exists but has no node_modules: delete it (the fixture script won't overwrite) and run again`);
    process.exit(2);
  }
  console.log(`making the fixture in ${fixture} (git repo + npm install, about a minute)`);
  const made = spawnSync(process.execPath, [join(kit, 'create-r2-fixture.mjs'), fixture], { stdio: 'inherit' });
  if (made.status !== 0) process.exit(made.status ?? 1);
}
const run = spawnSync(process.execPath, [join(kit, 'accept-r2.mjs'), '--modulegraph', repo, '--fixture', fixture, '--ui', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(run.status ?? 1);
