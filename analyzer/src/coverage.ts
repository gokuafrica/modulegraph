import { join } from 'node:path';
import type { AnalysisIssue } from '../../schema/modulegraph.ts';
import type { RevisionAnalysis } from './analyzers/types.ts';
import { hunks, type RawDiff } from './git.ts';

/**
 * Why a review may be incomplete: what the backend could not resolve on either revision, and changed code that is
 * in no flow it knows. A review with issues must not read as "nothing found": the brief's verdict says INCOMPLETE
 * and `--check` fails (unless `--allow-incomplete`).
 */
export function analysisIssues(head: RevisionAnalysis, base: RevisionAnalysis | undefined, diff: RawDiff | undefined, repo: string): AnalysisIssue[] {
  return [...revisionIssues(head, base), ...changeIssues(head, base, diff, repo)];
}

/** What each revision's analysis could not resolve (grows as a lazy analysis analyzes more). */
export function revisionIssues(head: RevisionAnalysis, base: RevisionAnalysis | undefined): AnalysisIssue[] {
  const out: AnalysisIssue[] = [];
  const own = head.issues?.() ?? [];
  out.push(...own);
  // The base is usually broken the same way (missing packages); say it once, unless only the base has it.
  for (const issue of base?.issues?.() ?? []) if (!own.some((i) => i.kind === issue.kind)) out.push({ ...issue, side: 'base' });
  return out;
}

/** Changed code the analysis can't place in any flow (depends only on the code and the diff). */
export function changeIssues(head: RevisionAnalysis, base: RevisionAnalysis | undefined, diff: RawDiff | undefined, repo: string): AnalysisIssue[] {
  const out: AnalysisIssue[] = [];
  const unmapped = unmappedChanges(head, base, diff, repo);
  if (unmapped.length) {
    const n = unmapped.length;
    out.push({
      kind: 'unmapped-change',
      message: `${n} changed function${n > 1 ? 's are' : ' is'} in no flow the analysis knows: ${unmapped.slice(0, 4).join(', ')}${n > 4 ? ', …' : ''}. What ${n > 1 ? 'they change' : 'it changes'} for callers and entry points is not in this review.`,
      hint: 'Read them by hand. Code a framework calls (a hook, a plugin, a handler registered in a way modulegraph does not know) can be described in the profile: entryPoints, decoratorEntries, sinks.',
      items: unmapped,
    });
  }
  return out;
}

/** Changed functions, on either side of the diff, that no operation or entry point covers. */
function unmappedChanges(head: RevisionAnalysis, base: RevisionAnalysis | undefined, diff: RawDiff | undefined, repo: string): string[] {
  if (!diff) return [];
  const byName = new Map<string, string>();
  const add = (descriptions: string[] | undefined) => {
    for (const d of descriptions ?? []) {
      const name = d.replace(/ \([^)]*\)$/, '');
      if (!byName.has(name)) byName.set(name, d);
    }
  };
  for (const f of hunks(diff.patch)) {
    if (f.head.length) add(head.unmappedChanges?.(abs(repo, f.path), f.head));
    if (f.base.length && base) add(base.unmappedChanges?.(abs(repo, f.basePath ?? f.path), f.base));
  }
  return [...byName.values()];
}

function abs(repo: string, rel: string): string {
  return join(repo, rel).replace(/\\/g, '/');
}

/** "INCOMPLETE" lines for the CLI report: one per issue, with its hint. */
export function issueLines(issues: AnalysisIssue[]): string[] {
  return issues.flatMap((i) => [`  ${i.kind}${i.side === 'base' ? ' (base revision)' : ''}: ${i.message}`, ...(i.hint ? [`    → ${i.hint}`] : [])]);
}
