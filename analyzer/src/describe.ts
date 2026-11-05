import type { ModuleGraph } from '../../schema/modulegraph.ts';
import type { Config } from './config.ts';

/**
 * Descriptions from the service profile, for modules and operations the code doesn't describe. The review agent
 * writes them (the brief's "Needs a description" lists the ones a review meets); a doc comment in the code wins.
 * Applied to the finished graph, so any language backend gets them and a refresh picks up profile edits.
 */
export function describe<G extends Pick<ModuleGraph, 'modules' | 'operations'>>(g: G, config: Config): G {
  const byClass = config.modules.overrides;
  for (const mod of Object.values(g.modules)) {
    const o = byClass[mod.className];
    if (o?.summary) Object.assign(mod, { summary: o.summary.replace(/\s+/g, ' '), summarySource: 'profile' });
  }
  for (const op of Object.values(g.operations)) {
    if (op.summarySource === 'code') continue;
    const written = byClass[g.modules[op.moduleId]?.className ?? '']?.operations?.[op.name];
    if (written) Object.assign(op, { summary: written.replace(/\s+/g, ' '), summarySource: 'profile' });
    else if (op.summarySource === 'profile') Object.assign(op, { summary: undefined, summarySource: undefined });
  }
  return g;
}

/** What `describe` reads from a profile: equal keys = nothing to re-apply. */
export function descriptionsKey(config: Config): string {
  return JSON.stringify(Object.entries(config.modules.overrides).map(([cls, o]) => [cls, o.summary, o.operations]));
}
