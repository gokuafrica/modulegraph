import type { ModuleGraph } from '../../schema/modulegraph.ts';
import type { Config } from './config.ts';

/**
 * Descriptions for modules and operations the code doesn't describe, best source first:
 *   1. the method's own doc comment (`code`, set by the backend);
 *   2. the service profile (`profile`): the review agent writes these, the brief's "Needs a description" lists them;
 *   3. the API documentation of the entry point that hands the request to the operation (`api`: a controller method
 *      with `@ApiOperation({ description })` whose handler only calls this operation);
 *   4. the doc comment of the operation's class (`class`, set by the backend).
 * Applied to the finished graph, so any language backend gets them and a refresh picks up profile edits.
 */
export function describe<G extends Pick<ModuleGraph, 'modules' | 'operations'> & Partial<Pick<ModuleGraph, 'entryPoints' | 'scopes'>>>(g: G, config: Config): G {
  const byClass = config.modules.overrides;
  for (const mod of Object.values(g.modules)) {
    const o = byClass[mod.className];
    if (o?.summary) Object.assign(mod, { summary: o.summary.replace(/\s+/g, ' '), summarySource: 'profile' });
  }
  for (const op of Object.values(g.operations)) {
    if (op.summarySource === 'code') continue;
    const written = byClass[g.modules[op.moduleId]?.className ?? '']?.operations?.[op.name];
    if (written) Object.assign(op, { summary: written.replace(/\s+/g, ' '), summarySource: 'profile', summaryFrom: undefined });
    else if (op.summarySource === 'profile' || op.summarySource === 'api') Object.assign(op, { summary: undefined, summarySource: undefined, summaryFrom: undefined });
  }
  // An endpoint whose handler only hands the request to one operation documents that operation too.
  for (const entry of Object.values(g.entryPoints ?? {})) {
    if (!entry.summary || entry.change === 'removed') continue;
    const steps = (g.scopes?.[entry.id]?.steps ?? []).filter((s) => !s.pipeline);
    const op = steps.length === 1 && steps[0].kind === 'call' ? g.operations[steps[0].target!] : undefined;
    if (!op || (op.summary && op.summarySource !== 'class')) continue;
    Object.assign(op, { summary: entry.summary, summarySource: 'api', summaryFrom: `${entry.summaryFrom ?? 'API docs'} on ${entry.label}` });
  }
  return g;
}

/** What `describe` reads from a profile: equal keys = nothing to re-apply. */
export function descriptionsKey(config: Config): string {
  return JSON.stringify(Object.entries(config.modules.overrides).map(([cls, o]) => [cls, o.summary, o.operations]));
}
