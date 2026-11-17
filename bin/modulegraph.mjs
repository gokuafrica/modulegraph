#!/usr/bin/env node
/**
 * modulegraph: module-level review of a change. Run it from the service folder (the one with package.json), or
 * pass --project <dir>. Nothing in the analyzed repo is changed.
 *
 *   modulegraph review [options]    analyze the change and open the interactive review (keeps running until idle)
 *   modulegraph analyze [options]   one-shot: write the review graph and the brief, print the summary, exit
 *   modulegraph open [<id>]         show saved reviews in the browser (no analysis)
 *   modulegraph stop [<id>]         stop review servers (deletes nothing)
 *   modulegraph done [<id>]         end a review: stop its server, delete its graph, brief, PR ref and temp files
 *   modulegraph clean               delete old reviews and leftovers
 *   modulegraph setup               install dependencies, build the UI, install the agent skill (re-run after updating)
 *   modulegraph help                every option
 *
 * Without a mode, both review the branch checked out (committed and uncommitted) against the repo's default branch.
 */
import { spawn, spawnSync } from 'node:child_process';
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
} else if (command === 'stop' || command === 'done' || command === 'clean') {
  script = 'analyzer/src/end.ts';
  args = [command, ...rest];
} else if (command === 'review') {
  // Lazy (fast on big services), served, and opened in the browser unless --no-open.
  args = ['--lazy', '--serve', ...(rest.includes('--no-open') ? [] : ['--open']), ...rest.filter((a) => a !== '--no-open')];
} else if (command === 'analyze') {
  args = rest;
} else if (!command || command === 'help' || command === '--help' || command === '-h') {
  console.log(`modulegraph: module-level review of a change

  modulegraph review [options]    analyze the change and open the interactive review; keeps serving it until
                                  30 min pass with no requests (--idle <minutes>, 0 = never), Ctrl+C, or stop/done
  modulegraph analyze [options]   one-shot: write the review graph and brief, print the summary
  modulegraph open [<id>]         show saved reviews in the browser (no analysis; also stops when idle)
  modulegraph setup               install dependencies, build the UI, install the agent skill

Ending reviews (reviews are saved in ~/.modulegraph/reviews/ until you remove them):
  modulegraph stop [<id>]         stop the server serving <id>, or every modulegraph server; deletes nothing
  modulegraph done [<id>]         the review is finished: stop its server and delete its graph, brief and
                                  index entry, its refs/modulegraph/pr-<n> ref and leftover scenario temp folders.
                                  No id: the one review being served. --keep-brief keeps <id>.brief.md;
                                  --dry-run lists what it would do. Same as the review page's "done" button
  modulegraph clean               delete reviews older than 14 days that no server is serving, PR refs no review
                                  uses, and scenario temp folders of runs that were killed, in every repo
                                  modulegraph has read. --older-than <days> (0 = all), --dry-run

Run it in the service folder (or pass --project <dir>). Without a mode it reviews the branch checked out,
committed and uncommitted, against the repo's default branch. Options of review and analyze:
`);
  args = ['--help'];
} else if (command.startsWith('--')) {
  args = [command, ...rest];
} else {
  console.error(`unknown command "${command}": use review, analyze, open, stop, done, clean, setup or help`);
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
// The IPC channel ties a review server to this process: if this one is killed (even hard, on Windows), the server
// sees the channel close and stops, instead of running on unseen.
const serves = script === 'analyzer/src/open.ts' || args.includes('--serve');
const child = spawn(process.execPath, ['--import', tsx, join(root, script), ...args], { stdio: ['inherit', 'inherit', 'inherit', ...(serves ? ['ipc'] : [])], env });
// Ctrl+C reaches both processes in a terminal; pass other stop requests on, and exit when the child has.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', (err) => {
  console.error(String(err));
  process.exit(1);
});
