/**
 * Shows a saved review in the browser. When the code it reviewed is still on this machine (the project folder, and
 * the branches or PR ref it compared), the review is served live, like `modulegraph review`: refresh, done, and
 * analysis on demand all work, and what was explored in it is analyzed again. Otherwise (or with --static) the saved
 * files are shown as they are, and the page says why and what to run.
 *
 * usage: modulegraph open [<review id>] [--static] [--port 5174] [--idle <minutes>] [--no-open]
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ModuleGraph } from '../../schema/modulegraph.ts';
import { git } from './git.ts';
import { appRoot, demoGraphsDir, uiDistDir, userReviewsDir } from './home.ts';
import { serveStatic } from './server.ts';

const { values, positionals } = parseArgs({
  options: { port: { type: 'string' }, idle: { type: 'string' }, static: { type: 'boolean' }, 'no-open': { type: 'boolean' } },
  allowPositionals: true,
});
const idleMinutes = values.idle === undefined ? undefined : Number(values.idle);
if (idleMinutes !== undefined && !(idleMinutes >= 0)) {
  console.error('--idle takes a number of minutes (0 = never stop by itself)');
  process.exit(2);
}
const port = values.port ?? '5174';
const id = positionals[0] ?? latestReview();
const file = id ? [userReviewsDir, demoGraphsDir].map((d) => join(d, `${id}.json`)).find(existsSync) : undefined;
const live = !values.static && file ? liveArgs(file) : undefined;

if (live && 'args' in live) {
  // The same process becomes the review server (cli.ts), so `modulegraph stop` / `done` and the idle timer work as
  // for `modulegraph review`.
  console.log(`modulegraph: the code of ${id} is still here; serving it live (refresh and done work). --static shows only the saved file.`);
  process.argv = [process.argv[0], fileURLToPath(new URL('./cli.ts', import.meta.url)), ...live.args];
  await import('./cli.ts');
} else {
  const reason = values.static ? 'opened with --static' : !id ? undefined : !file ? `no saved review called ${id}` : live?.reason;
  if (reason && id) console.log(`modulegraph: showing the saved review only (${reason}).`);
  serveStatic({
    graphsDirs: [userReviewsDir, demoGraphsDir], uiDir: uiDistDir, port: Number(port), open: id, idleMinutes,
    noBrowser: values['no-open'], savedReasons: id && reason ? { [id]: reason } : {},
  });
}

/** The newest review in your reviews folder. */
function latestReview(): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(userReviewsDir, 'index.json'), 'utf8')) as { id: string }[])[0]?.id;
  } catch {
    return undefined;
  }
}

/** Arguments that analyze the saved review again (live), or why that is not possible. */
function liveArgs(jsonFile: string): { args: string[] } | { reason: string } {
  let g: ModuleGraph;
  try {
    g = JSON.parse(readFileSync(jsonFile, 'utf8')) as ModuleGraph;
  } catch {
    return { reason: 'the saved file could not be read' };
  }
  const s = g.source;
  if (!s?.repo || !s.mode) return { reason: 'the saved review does not say which code it read' };
  if (g.generator?.startsWith('agent:')) return { reason: 'it was written by an agent, not analyzed' };
  const repo = isAbsolute(s.repo) ? s.repo : resolve(appRoot, s.repo);
  const projectDir = join(repo, s.project ?? '.').replace(/\\/g, '/');
  if (!existsSync(projectDir)) return { reason: `the project folder is gone (${projectDir})` };
  const has = (ref: string) => {
    try {
      git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };
  const mode: string[] = [];
  if (s.mode === 'snapshot') mode.push('--snapshot');
  else if (s.mode === 'uncommitted') mode.push('--uncommitted');
  else if (s.mode === 'pr') {
    const n = (s.head ?? '').replace(/^#/, '');
    if (!has(`refs/modulegraph/pr-${n}`)) return { reason: `the PR ref refs/modulegraph/pr-${n} is gone (run \`modulegraph review --pr ${n}\` to fetch it again)` };
    mode.push('--pr', n);
  } else {
    if (s.head && !has(s.head)) return { reason: `the branch ${s.head} is gone` };
    if (s.base && !has(s.base)) return { reason: `the base ${s.base} is gone` };
    mode.push(...(s.head ? ['--head', s.head] : []), '--base', s.base ?? 'main');
  }
  // The profile the review used, when it was given explicitly (found by package name otherwise).
  const profile = s.profile?.exists && s.profile.path ? s.profile.path.replace(/^~(?=\/)/, process.env.USERPROFILE ?? process.env.HOME ?? '~') : undefined;
  const explicit = profile && /--config\b/.test(s.command ?? '') ? ['--config', isAbsolute(profile) ? profile : resolve(appRoot, profile)] : [];
  return {
    args: [
      '--project', projectDir, ...mode, ...explicit, '--lazy', '--serve', '--name', id!, '--resume', jsonFile, '--port', port,
      ...(values.idle !== undefined ? ['--idle', values.idle] : []), ...(values['no-open'] ? [] : ['--open']),
      ...(s.title ? ['--title', s.title] : []),
    ],
  };
}
