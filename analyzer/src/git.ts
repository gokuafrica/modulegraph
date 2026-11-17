import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FileChange } from '../../schema/modulegraph.ts';

let gitBin = process.env.MODULEGRAPH_GIT ?? 'git';
let ghBin = process.env.MODULEGRAPH_GH ?? 'gh';

/**
 * Where git and gh are usually installed, for when PATH doesn't reach them: on Windows, shells such as Git Bash can
 * hand child processes a PATH that native programs can't read (npm scripts started from an agent's shell hit this);
 * on macOS, a process started from the GUI gets launchd's short PATH, without Homebrew's folders.
 */
const INSTALLED: Record<'git' | 'gh', string[]> = {
  git: [
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
    '/usr/bin/git',
  ],
  gh: ['C:\\Program Files\\GitHub CLI\\gh.exe', 'C:\\Program Files (x86)\\GitHub CLI\\gh.exe', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'],
};

/**
 * The binary to run for `tool`: `bin` when it is on PATH, else the first installed copy. `run` is only called again
 * when `bin` was not found (ENOENT); every other error is the tool's own and is thrown as it is.
 */
function withTool(tool: 'git' | 'gh', bin: string, run: (bin: string) => string): { out: string; bin: string } {
  try {
    return { out: run(bin), bin };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const found = INSTALLED[tool].find((c) => existsSync(c));
  if (!found) {
    const what = tool === 'git' ? 'git' : 'the GitHub CLI (gh)';
    throw new ToolNotFound(`${tool} not found on PATH. Install ${what} or set ${tool === 'git' ? 'MODULEGRAPH_GIT' : 'MODULEGRAPH_GH'} to its full path.`);
  }
  return { out: run(found), bin: found };
}
class ToolNotFound extends Error {}

/** Runs git in `repo` (see INSTALLED for where it looks when git isn't on PATH). */
export function git(repo: string, args: string[]): string {
  const run = (bin: string) => execFileSync(bin, args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const r = withTool('git', gitBin, run);
    gitBin = r.bin;
    return r.out;
  } catch (err) {
    if (err instanceof ToolNotFound) throw err;
    // Say what git said: "Command failed" alone doesn't tell a reviewer why a refresh failed.
    const stderr = String((err as { stderr?: string }).stderr ?? '').trim();
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr.split('\n').slice(0, 3).join(' ')}` : ` (exit ${(err as { status?: number }).status ?? '?'})`}`);
  }
}

/** Subjects and bodies of the commits in base..head: the change's stated intent when no PR text is given. */
export function commitMessages(repo: string, base: string, head: string): { title?: string; intent?: string } {
  const log = git(repo, ['log', '--reverse', '--format=%s%n%b%x1e', `${base}..${head}`]).split('\x1e').map((m) => m.trim()).filter(Boolean);
  if (!log.length) return {};
  const strip = (m: string) => m.split('\n').filter((l) => !/^(Co-Authored-By|Signed-off-by):/i.test(l.trim())).join('\n').trim();
  return { title: log.length === 1 ? log[0].split('\n')[0] : undefined, intent: log.map(strip).join('\n\n') };
}

export function repoRootOf(dir: string): string {
  return git(dir, ['rev-parse', '--show-toplevel']).trim();
}

/** Source files of `projectRel` as they exist at `ref`, keyed by absolute path. `include` is the backend's file filter. */
export function filesAtRef(repo: string, ref: string, projectRel: string, include: (path: string) => boolean = (f) => /\.tsx?$/.test(f) && !f.includes('node_modules/')): Map<string, string> {
  const names = git(repo, ['ls-tree', '-r', '--name-only', ref, '--', projectRel])
    .split('\n')
    .filter((f) => f && include(f));
  const files = new Map<string, string>();
  for (const name of names) files.set(join(repo, name).replace(/\\/g, '/'), git(repo, ['show', `${ref}:${name}`]));
  return files;
}

export interface RawDiff {
  files: FileChange[];
  /** Unified diff text with zero context, for line-level risk scanning. */
  patch: string;
}

/** Diff between two commits, or between a commit and the working tree (head = undefined), incl. untracked files. */
export function diffBetween(repo: string, base: string, head: string | undefined, projectRel: string): RawDiff {
  const range = head ? [base, head] : [base];
  const numstat = git(repo, ['diff', '--numstat', '-M', ...range, '--', projectRel]);
  const status = git(repo, ['diff', '--name-status', '-M', ...range, '--', projectRel]);
  let patch = git(repo, ['diff', '-U0', '-M', ...range, '--', projectRel]);

  const statusByPath = new Map<string, FileChange['status']>();
  for (const line of status.split('\n').filter(Boolean)) {
    const [code, ...paths] = line.split('\t');
    const map: Record<string, FileChange['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };
    statusByPath.set(paths.at(-1)!, map[code[0]] ?? 'modified');
  }
  const files: FileChange[] = numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...rest] = line.split('\t');
      const path = rest.join('\t').replace(/^.*=> /, '').replace(/[{}]/g, '');
      return { path, status: statusByPath.get(path) ?? 'modified', added: Number(added) || 0, removed: Number(removed) || 0, modules: [] };
    });

  if (!head) {
    const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '--', projectRel]).split('\n').filter(Boolean);
    for (const path of untracked) {
      const text = readFileSync(join(repo, path), 'utf8');
      const lines = text.split('\n');
      files.push({ path, status: 'added', added: lines.length, removed: 0, modules: [] });
      patch += `\ndiff --git a/${path} b/${path}\nnew file\n+++ b/${path}\n${lines.map((l) => `+${l}`).join('\n')}`;
    }
  }
  return { files, patch };
}

export interface FileHunks {
  /** Path relative to the repo (head side; base side for deletions). */
  path: string;
  basePath?: string;
  /** Changed line ranges on the base side (removed/replaced lines). */
  base: [number, number][];
  /** Changed line ranges on the head side (added/replaced lines). */
  head: [number, number][];
}

/** Changed line ranges per file from a zero-context patch (`git diff -U0`). */
export function hunks(patch: string): FileHunks[] {
  const out: FileHunks[] = [];
  let cur: FileHunks | undefined;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { path: '', base: [], head: [] };
      out.push(cur);
    } else if (cur && line.startsWith('--- ')) {
      if (line !== '--- /dev/null') cur.basePath = line.slice(6);
    } else if (cur && line.startsWith('+++ ')) {
      cur.path = line === '+++ /dev/null' ? cur.basePath ?? '' : line.slice(6);
    } else if (cur && line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const [b, bn, h, hn] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
      if (bn > 0) cur.base.push([b, b + bn - 1]);
      if (hn > 0) cur.head.push([h, h + hn - 1]);
    }
  }
  // Untracked files are appended without hunk headers: the whole file is new.
  for (const f of out) if (!f.head.length && !f.base.length && f.path) f.head.push([1, 100000]);
  return out.filter((f) => f.path);
}

export function mergeBase(repo: string, a: string, b: string): string {
  return git(repo, ['merge-base', a, b]).trim();
}

/** The branch checked out in `repo` (a worktree has its own), or HEAD when detached. */
export function currentBranch(repo: string): string {
  const name = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  return name === 'HEAD' ? 'HEAD' : name;
}

/** Uncommitted edits (incl. untracked files) under `path` in the checkout. */
export function hasLocalChanges(repo: string, path: string): boolean {
  return git(repo, ['status', '--porcelain', '--untracked-files=all', '--', path]).trim().length > 0;
}

/**
 * Cheap fingerprint of what a review reads: the commits, plus the uncommitted edits (file list with sizes and
 * modification times). Equal fingerprints = nothing to re-analyze. No file contents are read.
 */
export function workingStateKey(repo: string, refs: string[], path: string, workingTree: boolean): string {
  const shas = refs.map((r) => { try { return revParse(repo, r); } catch { return r; } });
  if (!workingTree) return shas.join(' ');
  const status = git(repo, ['status', '--porcelain', '--untracked-files=all', '--', path]).split('\n').filter(Boolean);
  const stamps = status.map((line) => {
    const file = line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '');
    try {
      const st = statSync(join(repo, file));
      return `${line} ${st.size} ${st.mtimeMs}`;
    } catch {
      return line;
    }
  });
  return [...shas, ...stamps].join('\n');
}

export function revParse(repo: string, ref: string): string {
  return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
}

/**
 * The branch changes are compared with when none is named: the remote's default branch (origin/HEAD), as a local
 * branch when there is one, else main, master, or the remote's copy of either. Undefined in a repo with none.
 */
export function defaultBranch(repo: string): string | undefined {
  const exists = (ref: string) => {
    try {
      revParse(repo, ref);
      return true;
    } catch {
      return false;
    }
  };
  let remote: string | undefined;
  try {
    remote = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim();
  } catch {
    // no remote, or origin/HEAD not set
  }
  const local = remote?.replace(/^origin\//, '');
  const candidates = [local, remote, 'main', 'master', 'origin/main', 'origin/master'].filter((c): c is string => !!c);
  return candidates.find(exists);
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  baseRefName: string;
  headRefName: string;
}

/** Fetches a GitHub PR's head into a local ref via `gh` + git, returns its metadata. */
export function fetchPullRequest(repo: string, number: number): PullRequest & { headRef: string; baseRef: string } {
  const view = withTool('gh', ghBin, (bin) =>
    execFileSync(bin, ['pr', 'view', String(number), '--json', 'number,title,body,baseRefName,headRefName'], { cwd: repo, encoding: 'utf8' }),
  );
  ghBin = view.bin;
  const pr = JSON.parse(view.out) as PullRequest;
  const headRef = `refs/modulegraph/pr-${number}`;
  git(repo, ['fetch', 'origin', `pull/${number}/head:${headRef}`, '--force']);
  git(repo, ['fetch', 'origin', pr.baseRefName]);
  return { ...pr, headRef, baseRef: `origin/${pr.baseRefName}` };
}
