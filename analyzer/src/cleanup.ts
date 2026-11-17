/**
 * Ending reviews: what a review leaves behind, and removing it. Every deletion uses Node's fs and git itself, so it
 * works the same on Windows, macOS and Linux.
 *
 * A review leaves:
 *   - ~/.modulegraph/reviews/<id>.json (the graph, which holds source code), <id>.brief.md, its index.json entry;
 *   - with --pr: the ref refs/modulegraph/pr-<n> in the reviewed repo;
 *   - with a scenario: <repo>/.modulegraph-tmp/<pid>/ and a git worktree in it, removed when the run ends, left
 *     behind when the process was killed mid-run.
 *
 * In the reviewed repo only those are ever touched: refs under refs/modulegraph/, folders under .modulegraph-tmp/
 * whose process is gone, and git worktrees registered under .modulegraph-tmp/. Never a blanket `git worktree
 * prune`, which would also drop the user's own worktrees whose folder is missing (on a detached drive, say).
 * The shipped demo graphs (ui/public/graphs) are never deleted.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ModuleGraph } from '../../schema/modulegraph.ts';
import { git } from './git.ts';
import { appRoot, demoGraphsDir, homeDir, userReviewsDir } from './home.ts';
import { alive, listServers } from './servers.ts';

export const reposFile = join(homeDir, 'repos.json').replace(/\\/g, '/');
const TMP = '.modulegraph-tmp';
const PR_REFS = 'refs/modulegraph/';

/** Ids are file names: no separators, no "..". */
export function validId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..');
}

const norm = (p: string) => {
  const r = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const inside = (root: string, p: string) => {
  const rel = relative(norm(root), norm(p));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};
const tryGit = (repo: string, args: string[]): string | undefined => {
  try {
    return git(repo, args);
  } catch {
    return undefined;
  }
};

// ---------- which repos modulegraph has worked in ----------

/** Remembers a repo the analyzer read, so `clean` can find its leftovers after its reviews are gone. */
export function recordRepo(repo: string): void {
  const repos = knownRepoList();
  if (repos.some((r) => norm(r) === norm(repo))) return;
  mkdirSync(dirname(reposFile), { recursive: true });
  writeFileSync(reposFile, JSON.stringify([...repos, repo.replace(/\\/g, '/')], null, 2));
}

function knownRepoList(): string[] {
  try {
    return JSON.parse(readFileSync(reposFile, 'utf8')) as string[];
  } catch {
    return [];
  }
}

// ---------- one review ----------

interface ReviewSource {
  repo?: string;
  /** PR number when it was reviewed with --pr. */
  pr?: number;
}

/** The repo and PR a saved review read, from its graph file. */
function sourceOf(jsonFile: string): ReviewSource {
  try {
    const g = JSON.parse(readFileSync(jsonFile, 'utf8')) as Pick<ModuleGraph, 'source'>;
    const s = g.source;
    if (!s?.repo) return {};
    // The demos' graphs store the repo relative to the modulegraph checkout.
    const repo = (isAbsolute(s.repo) ? s.repo : resolve(appRoot, s.repo)).replace(/\\/g, '/');
    const pr = s.mode === 'pr' ? Number(/^#(\d+)$/.exec(s.head ?? '')?.[1]) : NaN;
    return { repo, pr: Number.isInteger(pr) ? pr : undefined };
  } catch {
    return {};
  }
}

export interface EndOptions {
  /** Keep <id>.brief.md (the review facts) and delete the rest. */
  keepBrief?: boolean;
  /** Only say what would be removed. */
  dryRun?: boolean;
}

export interface ReviewFiles {
  id: string;
  json: string;
  brief: string;
  /** index.json listing it; undefined when it was written with --out. */
  indexFile?: string;
}

export function reviewFiles(id: string, dir = userReviewsDir): ReviewFiles {
  return { id, json: join(dir, `${id}.json`), brief: join(dir, `${id}.brief.md`), indexFile: join(dir, 'index.json') };
}

/**
 * Removes one review: its graph, brief (unless keepBrief) and index entry, the PR ref it fetched (unless another
 * saved review still uses it), and the scenario leftovers of dead processes in its repo. Returns what it removed
 * (or would remove, with dryRun). Shipped demo graphs are kept.
 */
export function endReview(files: ReviewFiles, opts: EndOptions = {}): string[] {
  if (!validId(files.id)) throw new Error(`not a review id: ${files.id}`);
  const removed: string[] = [];
  const src = existsSync(files.json) ? sourceOf(files.json) : {};
  if (!inside(demoGraphsDir, files.json)) {
    const del = (file: string) => {
      if (!existsSync(file)) return;
      if (!opts.dryRun) rmSync(file, { force: true });
      removed.push(display(file));
    };
    del(files.json);
    // Jest's output from recording examples (written next to the graph when the tests ran).
    del(files.json.replace(/[.]json$/, '.tests.log'));
    if (!opts.keepBrief) del(files.brief);
    if (files.indexFile) removed.push(...dropFromIndex(files.indexFile, [files.id], opts.dryRun));
  }
  if (src.repo && existsSync(src.repo)) {
    if (src.pr !== undefined) {
      const ref = `${PR_REFS}pr-${src.pr}`;
      const stillUsed = savedReviews().some((r) => r.id !== files.id && r.pr === src.pr && r.repo && norm(r.repo) === norm(src.repo!));
      if (!stillUsed && tryGit(src.repo, ['rev-parse', '--verify', '--quiet', ref]) !== undefined) {
        if (!opts.dryRun) git(src.repo, ['update-ref', '-d', ref]);
        removed.push(`${ref} in ${src.repo}`);
      }
    }
    removed.push(...cleanRepoTemp(src.repo, opts.dryRun));
  }
  return removed;
}

function dropFromIndex(indexFile: string, ids: string[], dryRun?: boolean): string[] {
  if (!existsSync(indexFile)) return [];
  let index: { id: string }[];
  try {
    index = JSON.parse(readFileSync(indexFile, 'utf8')) as { id: string }[];
  } catch {
    return [];
  }
  const gone = index.filter((e) => ids.includes(e.id));
  if (!gone.length) return [];
  if (!dryRun) writeFileSync(indexFile, JSON.stringify(index.filter((e) => !ids.includes(e.id)), null, 2));
  return gone.map((e) => `index entry ${e.id}`);
}

// ---------- leftovers in a reviewed repo ----------

/** Removes the `node_modules` links an analysis put into a temporary worktree (never what they point to). */
function unlinkModuleLinks(dir: string, depth = 0): void {
  if (depth > 6 || !existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      if (name === 'node_modules') unlinkSync(path);
    } else if (stat.isDirectory() && name !== 'node_modules' && name !== '.git') unlinkModuleLinks(path, depth + 1);
  }
}

/** Paths of the repo's git worktrees, from git's own list (including those whose folder is gone). */
function worktrees(repo: string): string[] {
  const out = tryGit(repo, ['worktree', 'list', '--porcelain']) ?? '';
  return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim());
}

/**
 * <repo>/.modulegraph-tmp/<pid>/ folders whose process is gone (killed while recording examples), with their git
 * worktrees. Folders of running analyses are left alone.
 */
export function cleanRepoTemp(repo: string, dryRun?: boolean): string[] {
  const tmpRoot = join(repo, TMP);
  const removed: string[] = [];
  // Only what an analysis creates: <pid>/ folders (and worktrees in them) of processes that are gone. Anything else
  // in .modulegraph-tmp (output someone wrote there with --out, an older version's files) is not ours to delete.
  const deadPid = (name: string | undefined) => !!name && /^\d+$/.test(name) && (!alive(Number(name)) || Number(name) === process.pid);
  const pidOf = (p: string) => relative(norm(tmpRoot), norm(p)).replace(/\\/g, '/').split('/')[0];
  // Worktrees first (git must forget them), also those whose folder was deleted by hand.
  for (const wt of worktrees(repo).filter((w) => inside(tmpRoot, w) && deadPid(pidOf(w)))) {
    // The checkout's node_modules are linked into it: unlink them first, so removing it never reaches into them.
    if (!dryRun) unlinkModuleLinks(wt);
    if (!dryRun && tryGit(repo, ['worktree', 'remove', '--force', wt]) === undefined && existsSync(wt)) rmSync(wt, { recursive: true, force: true });
    removed.push(`git worktree ${wt}`);
  }
  if (!existsSync(tmpRoot)) return removed;
  for (const name of readdirSync(tmpRoot).filter(deadPid)) {
    if (!dryRun) rmSync(join(tmpRoot, name), { recursive: true, force: true });
    removed.push(join(tmpRoot, name).replace(/\\/g, '/'));
  }
  if (!dryRun && !readdirSync(tmpRoot).length) rmSync(tmpRoot, { recursive: true, force: true });
  return removed;
}

/** refs/modulegraph/pr-* in a repo that no saved review in `keep` uses. */
function unusedPrRefs(repo: string, keep: SavedReview[]): string[] {
  const refs = (tryGit(repo, ['for-each-ref', '--format=%(refname)', PR_REFS]) ?? '').split('\n').map((r) => r.trim()).filter(Boolean);
  const used = new Set(keep.filter((r) => r.repo && r.pr !== undefined && norm(r.repo) === norm(repo)).map((r) => `${PR_REFS}pr-${r.pr}`));
  return refs.filter((r) => !used.has(r));
}

// ---------- every review ----------

export interface SavedReview extends ReviewSource {
  id: string;
  /** When it was analyzed (index entry, else the graph's generatedAt, else the file's time). */
  at: number;
  title?: string;
  hasJson: boolean;
  hasBrief: boolean;
  inIndex: boolean;
}

/** Reviews in ~/.modulegraph/reviews: those in index.json and any stray graph or brief files. */
export function savedReviews(dir = userReviewsDir): SavedReview[] {
  if (!existsSync(dir)) return [];
  const indexFile = join(dir, 'index.json');
  let index: { id: string; title?: string; generatedAt?: string }[] = [];
  try {
    index = existsSync(indexFile) ? (JSON.parse(readFileSync(indexFile, 'utf8')) as typeof index) : [];
  } catch {
    // unreadable index: the files still count
  }
  const names = readdirSync(dir);
  const ids = new Set([
    ...index.map((e) => e.id),
    ...names.filter((n) => n.endsWith('.json') && n !== 'index.json').map((n) => n.slice(0, -'.json'.length)),
    ...names.filter((n) => n.endsWith('.brief.md')).map((n) => n.slice(0, -'.brief.md'.length)),
  ]);
  return [...ids].filter(validId).map((id) => {
    const f = reviewFiles(id, dir);
    const entry = index.find((e) => e.id === id);
    const hasJson = existsSync(f.json);
    const hasBrief = existsSync(f.brief);
    let at = entry?.generatedAt ? Date.parse(entry.generatedAt) : NaN;
    if (Number.isNaN(at)) {
      const file = hasJson ? f.json : hasBrief ? f.brief : undefined;
      at = file ? statSync(file).mtimeMs : 0;
    }
    return { id, at, title: entry?.title, hasJson, hasBrief, inIndex: !!entry, ...(hasJson ? sourceOf(f.json) : {}) };
  });
}

export interface CleanOptions {
  /** Reviews analyzed more than this many days ago are removed (default 14; 0 = all). */
  olderThanDays?: number;
  dryRun?: boolean;
  now?: number;
}

export interface CleanReport {
  removed: string[];
  /** Reviews kept because a server is serving them. */
  served: string[];
  kept: number;
}

/**
 * Removes old reviews (not ones a running server serves), index entries without files, and in every repo
 * modulegraph knows of: PR refs no remaining review uses and the scenario leftovers of dead processes.
 */
export function clean(opts: CleanOptions = {}): CleanReport {
  const days = opts.olderThanDays ?? 14;
  const cutoff = (opts.now ?? Date.now()) - days * 86_400_000;
  const servers = listServers();
  const served = new Set(servers.flatMap((s) => s.ids));
  const removed: string[] = [];
  const all = savedReviews();
  const keep: SavedReview[] = [];
  const servedKept: string[] = [];
  for (const r of all) {
    if (served.has(r.id)) {
      servedKept.push(r.id);
      keep.push(r);
    } else if (!r.hasJson && !r.hasBrief) {
      removed.push(...dropFromIndex(join(userReviewsDir, 'index.json'), [r.id], opts.dryRun));
    } else if (r.at <= cutoff) {
      const f = reviewFiles(r.id);
      for (const file of [f.json, f.brief]) {
        if (!existsSync(file)) continue;
        if (!opts.dryRun) rmSync(file, { force: true });
        removed.push(display(file));
      }
      removed.push(...dropFromIndex(f.indexFile!, [r.id], opts.dryRun));
    } else keep.push(r);
  }
  // Repos: the ones the analyzer recorded (repos.json) and the ones remaining reviews read.
  const repos = new Map<string, string>();
  for (const r of [...knownRepoList(), ...all.map((x) => x.repo).filter((x): x is string => !!x)]) repos.set(norm(r), r);
  const existing: string[] = [];
  for (const repo of repos.values()) {
    if (!existsSync(repo) || tryGit(repo, ['rev-parse', '--git-dir']) === undefined) continue;
    existing.push(repo);
    for (const ref of unusedPrRefs(repo, keep)) {
      if (!opts.dryRun) tryGit(repo, ['update-ref', '-d', ref]);
      removed.push(`${ref} in ${repo}`);
    }
    removed.push(...cleanRepoTemp(repo, opts.dryRun));
  }
  // Forget repos that no longer exist.
  if (!opts.dryRun && existsSync(reposFile)) writeFileSync(reposFile, JSON.stringify(existing, null, 2));
  return { removed, served: servedKept, kept: keep.length - servedKept.length };
}

/** Paths under the modulegraph home as ~/.modulegraph/…; others as they are. */
function display(file: string): string {
  const f = resolve(file).replace(/\\/g, '/');
  const home = resolve(homeDir).replace(/\\/g, '/');
  return (norm(f) + '/').startsWith(norm(home) + '/') && !process.env.MODULEGRAPH_HOME ? `~/.modulegraph${f.slice(home.length)}` : f;
}

