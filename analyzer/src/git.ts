import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileChange } from '../../schema/modulegraph.ts';

export function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function repoRootOf(dir: string): string {
  return git(dir, ['rev-parse', '--show-toplevel']).trim();
}

/** Source files of `projectRel` as they exist at `ref`, keyed by absolute path. */
export function filesAtRef(repo: string, ref: string, projectRel: string): Map<string, string> {
  const names = git(repo, ['ls-tree', '-r', '--name-only', ref, '--', projectRel])
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !f.includes('node_modules/'));
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

export function mergeBase(repo: string, a: string, b: string): string {
  return git(repo, ['merge-base', a, b]).trim();
}

export function revParse(repo: string, ref: string): string {
  return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
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
  const pr = JSON.parse(
    execFileSync('gh', ['pr', 'view', String(number), '--json', 'number,title,body,baseRefName,headRefName'], { cwd: repo, encoding: 'utf8' }),
  ) as PullRequest;
  const headRef = `refs/modulegraph/pr-${number}`;
  git(repo, ['fetch', 'origin', `pull/${number}/head:${headRef}`, '--force']);
  git(repo, ['fetch', 'origin', pr.baseRefName]);
  return { ...pr, headRef, baseRef: `origin/${pr.baseRefName}` };
}
