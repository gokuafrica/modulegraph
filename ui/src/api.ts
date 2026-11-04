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
