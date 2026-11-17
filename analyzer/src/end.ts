/**
 * Ending reviews.
 *   modulegraph stop [<id>]                              stop the server(s) serving a review (no id: every one); deletes nothing
 *   modulegraph done [<id>] [--keep-brief] [--dry-run]   stop its server and delete the review (graph, brief, index entry,
 *                                                        its PR ref, scenario leftovers); no id: the one review being served
 *   modulegraph clean [--older-than <days>] [--dry-run]  delete reviews older than <days> (default 14) that no server is
 *                                                        serving, PR refs and scenario leftovers nothing uses any more
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { clean, endReview, reviewFiles, savedReviews, validId } from './cleanup.ts';
import { demoGraphsDir, userReviewsDir } from './home.ts';
import { ACTION_HEADER, alive, listServers, type ServerEntry, stopServer } from './servers.ts';

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  options: {
    'keep-brief': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    'older-than': { type: 'string' },
  },
  allowPositionals: true,
});
const dryRun = !!values['dry-run'];
const verb = dryRun ? 'would remove' : 'removed';
const age = (ms: number) => {
  const h = (Date.now() - ms) / 3_600_000;
  return h < 1 ? 'just now' : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};
const describeServer = (s: ServerEntry) => `${s.kind === 'open' ? 'saved reviews (modulegraph open)' : s.kind === 'live-router' ? `live demo router for ${s.ids.join(', ')}` : s.ids.join(', ')} on port ${s.port} (pid ${s.pid})`;

async function stopAll(servers: ServerEntry[]): Promise<boolean> {
  let ok = true;
  // Routers first: they take their demo children down with them.
  for (const s of [...servers].sort((a, b) => Number(b.kind === 'live-router') - Number(a.kind === 'live-router'))) {
    if (!alive(s.pid)) continue;
    const r = dryRun ? { ok: true, note: 'dry run' } : await stopServer(s);
    console.log(`${r.ok ? (dryRun ? 'would stop' : 'stopped') : 'could not stop'} ${describeServer(s)}${r.note && r.note !== 'dry run' ? `: ${r.note}` : ''}`);
    ok &&= r.ok;
  }
  return ok;
}

function listCandidates(): void {
  const servers = listServers();
  if (servers.length) {
    console.log('running:');
    for (const s of servers) console.log(`  ${describeServer(s)}`);
  }
  const saved = savedReviews().sort((a, b) => b.at - a.at);
  if (saved.length) {
    console.log(`saved reviews (${userReviewsDir}):`);
    for (const r of saved.slice(0, 20)) console.log(`  ${r.id.padEnd(40)} ${age(r.at).padEnd(12)} ${r.title ?? ''}`);
    if (saved.length > 20) console.log(`  … and ${saved.length - 20} more (modulegraph clean removes old ones)`);
  }
  if (!servers.length && !saved.length) console.log('no reviews are saved or being served.');
}

if (command === 'stop') {
  const id = positionals[0];
  const servers = listServers().filter((s) => !id || s.ids.includes(id));
  if (!servers.length) {
    console.log(id ? `no running server serves ${id}.` : 'no modulegraph server is running.');
    process.exit(0);
  }
  // A demo router serves several reviews: stopping one of them stops only that one's own server.
  const own = id ? servers.filter((s) => s.kind !== 'live-router') : servers;
  process.exit((await stopAll(own.length ? own : servers)) ? 0 : 1);
}

if (command === 'done') {
  let id = positionals[0];
  const servers = listServers();
  if (!id) {
    const served = [...new Set(servers.filter((s) => s.kind === 'review').flatMap((s) => s.ids))];
    if (served.length !== 1) {
      console.log(served.length ? 'several reviews are being served: name one, e.g. modulegraph done <id>\n' : 'no review is being served: name the one you are done with, e.g. modulegraph done <id>\n');
      listCandidates();
      process.exit(2);
    }
    id = served[0];
  }
  if (!validId(id)) {
    console.error(`not a review id: ${id}`);
    process.exit(2);
  }
  // A running server ends its own review: it knows its files (also those written with --out).
  const own = servers.filter((s) => s.kind === 'review' && s.ids.includes(id));
  let handled = false;
  for (const s of own) {
    if (dryRun) {
      console.log(`would stop ${describeServer(s)}`);
      continue;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/graphs/${id}/done`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'done' },
        body: JSON.stringify({ keepBrief: !!values['keep-brief'] }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json()) as { removed?: string[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      for (const r of body.removed ?? []) console.log(`removed ${r}`);
      const until = Date.now() + 10_000;
      while (alive(s.pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      console.log(`stopped ${describeServer(s)}`);
      handled = true;
    } catch (err) {
      // Not answering (busy, or not ours): stop it the careful way, then delete here.
      const r = await stopServer(s);
      if (!r.ok) {
        console.error(`could not stop ${describeServer(s)}: ${r.note ?? String(err)}. Nothing was deleted.`);
        process.exit(1);
      }
      console.log(`stopped ${describeServer(s)}`);
    }
  }
  const files = reviewFiles(id);
  const saved = existsSync(files.json) || existsSync(files.brief) || savedReviews().some((r) => r.id === id);
  if (!handled && saved) for (const r of endReview(files, { keepBrief: !!values['keep-brief'], dryRun })) console.log(`${verb} ${r}`);
  if (!handled && !saved) {
    if (existsSync(`${demoGraphsDir}/${id}.json`)) console.log(`${id} is a shipped demo graph: kept${own.length ? ' (its server was stopped)' : ''}.`);
    else if (!own.length) {
      console.error(`no review named ${id}.\n`);
      listCandidates();
      process.exit(1);
    }
  }
  if (values['keep-brief'] && !dryRun) console.log(`kept ${files.brief.replace(/\\/g, '/')}`);
  process.exit(0);
}

if (command === 'clean') {
  const days = values['older-than'] === undefined ? 14 : Number(values['older-than']);
  if (!Number.isFinite(days) || days < 0) {
    console.error('--older-than takes a number of days (0 = every review that is not being served)');
    process.exit(2);
  }
  const report = clean({ olderThanDays: days, dryRun });
  for (const r of report.removed) console.log(`${verb} ${r}`);
  if (report.served.length) console.log(`kept (being served): ${report.served.join(', ')}`);
  console.log(`${report.removed.length ? '' : 'nothing to remove. '}${report.kept} review(s) newer than ${days} day(s) kept${dryRun ? ' (dry run: nothing was deleted)' : ''}.`);
  process.exit(0);
}

console.error(`unknown command "${command}": use stop, done or clean`);
process.exit(2);
