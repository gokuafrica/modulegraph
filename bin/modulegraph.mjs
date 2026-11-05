#!/usr/bin/env node
/**
 * modulegraph: module-level review of a change. Run it from the service folder (the one with package.json), or
 * pass --project <dir>. Nothing in the analyzed repo is changed.
 *
 *   modulegraph review [options]    analyze the change and open the interactive review (keeps running; Ctrl+C stops)
 *   modulegraph analyze [options]   one-shot: write the review graph and the brief, print the summary, exit
 *   modulegraph open [<id>]         show saved reviews in the browser (no analysis)
 *   modulegraph setup               install dependencies, build the UI, install the agent skill (re-run after updating)
 *   modulegraph help                every option
 *
 * Without a mode, both review the branch checked out (committed and uncommitted) against the repo's default branch.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [command, ...rest] = process.argv.slice(2);

if (command === 'setup') {
  const r = spawnSync(process.execPath, [join(root, 'scripts/setup.mjs'), ...rest], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

let script = 'analyzer/src/cli.ts';
let args;
if (command === 'open') {
  script = 'analyzer/src/open.ts';
  args = rest;
} else if (command === 'review') {
  // Lazy (fast on big services), served, and opened in the browser unless --no-open.
  args = ['--lazy', '--serve', ...(rest.includes('--no-open') ? [] : ['--open']), ...rest.filter((a) => a !== '--no-open')];
} else if (command === 'analyze') {
  args = rest;
} else if (!command || command === 'help' || command === '--help' || command === '-h') {
  console.log(`modulegraph: module-level review of a change

  modulegraph review [options]    analyze the change and open the interactive review (keeps running)
  modulegraph analyze [options]   one-shot: write the review graph and brief, print the summary
  modulegraph open [<id>]         show saved reviews in the browser (no analysis)
  modulegraph setup               install dependencies, build the UI, install the agent skill

Run it in the service folder (or pass --project <dir>). Without a mode it reviews the branch checked out,
committed and uncommitted, against the repo's default branch. Options of review and analyze:
`);
  args = ['--help'];
} else if (command.startsWith('--')) {
  args = [command, ...rest];
} else {
  console.error(`unknown command "${command}": use review, analyze, open, setup or help`);
  process.exit(2);
}

let tsx;
try {
  tsx = import.meta.resolve('tsx');
} catch {
  console.error(`modulegraph is not set up yet: run  node "${join(root, 'scripts/setup.mjs')}"`);
  process.exit(2);
}
// Relative paths in the options mean the folder the command was typed in.
const env = { ...process.env, INIT_CWD: process.cwd() };
const r = spawnSync(process.execPath, ['--import', tsx, join(root, script), ...args], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
