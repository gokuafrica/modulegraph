import type { ModuleGraph } from '../../schema/modulegraph.ts';

export type ExpandAction = 'callers' | 'reach' | 'entry' | 'op';

/**
 * Where a lazy graph's analysis server answers. Saved files written without `--serve` carry no address, so the
 * UI's own proxy (`/api` → `npm run live`) is assumed: a running server is always found.
 */
const apiOf = (g: ModuleGraph) => (g.lazy ? g.lazy.api ?? '/api' : undefined);

/** Live graph from the analysis server (`--lazy --serve`), or undefined when it isn't running. */
export async function fetchLive(g: ModuleGraph, graphId: string): Promise<ModuleGraph | undefined> {
  const api = apiOf(g);
  if (!api) return undefined;
  try {
    const res = await fetch(`${api}/graphs/${graphId}`, { cache: 'no-store' });
    return res.ok ? ((await res.json()) as ModuleGraph) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why a review is only a saved file here, when the server knows (`modulegraph open` found the project folder or the
 * branches gone): shown in the top bar. Undefined when it doesn't say, or nothing answers.
 */
export async function savedReason(g: ModuleGraph, graphId: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${apiOf(g) ?? '/api'}/graphs/${graphId}`, { cache: 'no-store' });
    if (res.ok || res.status >= 500) return undefined;
    return ((await res.json()) as { reason?: string }).reason;
  } catch {
    return undefined;
  }
}

/** Asks the server to analyze more of the graph; returns the updated graph. */
export async function expand(g: ModuleGraph, graphId: string, action: ExpandAction, id: string): Promise<ModuleGraph> {
  const res = await fetch(`${apiOf(g)}/graphs/${graphId}/expand`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, id }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
  return (await res.json()) as ModuleGraph;
}

export interface RefreshResult {
  changed: boolean;
  files: string[];
  baseKept?: boolean;
  ms: number;
  graph: ModuleGraph;
}

/** Re-analyzes after the code changed. The server re-reads only the files whose text changed. */
export async function refresh(g: ModuleGraph, graphId: string): Promise<RefreshResult> {
  const res = await fetch(`${apiOf(g)}/graphs/${graphId}/refresh`, { method: 'POST' });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
  return (await res.json()) as RefreshResult;
}

/**
 * True when the code changed since the last analysis (a cheap git check on the server, no analysis); undefined
 * when the server is gone (it stopped after being idle, or the review was ended).
 */
export async function isStale(g: ModuleGraph, graphId: string): Promise<boolean | undefined> {
  try {
    const res = await fetch(`${apiOf(g)}/graphs/${graphId}/status`, { cache: 'no-store' });
    // The dev server's proxy answers 5xx when nothing listens behind it.
    if (res.status >= 500) return undefined;
    return res.ok && ((await res.json()) as { stale?: boolean }).stale === true;
  } catch {
    return undefined;
  }
}

/** Ends the review: the server deletes its saved graph, brief, PR ref and temp files, then stops. */
export async function endReview(g: ModuleGraph, graphId: string): Promise<string[]> {
  const res = await fetch(`${apiOf(g)}/graphs/${graphId}/done`, {
    method: 'POST',
    // Required by the server: a page on another site can't send it without a CORS preflight, which is refused.
    headers: { 'content-type': 'application/json', 'x-modulegraph': 'done' },
    body: '{}',
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
  return ((await res.json()) as { removed?: string[] }).removed ?? [];
}

/** The reviews the analysis server is serving right now (empty when none is running). */
export async function servedGraphs(): Promise<string[]> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    return res.ok ? (((await res.json()) as { graphs?: string[] }).graphs ?? []) : [];
  } catch {
    return [];
  }
}
