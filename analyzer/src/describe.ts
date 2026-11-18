import type { ModuleGraph, ModuleInfo } from '../../schema/modulegraph.ts';
import type { Config, ModuleOverride } from './config.ts';

/**
 * Descriptions for modules and operations the code doesn't describe, best source first:
 *   1. the method's own doc comment (`code`, set by the backend);
 *   2. the service profile (`profile`): the review agent writes these, the brief's "Needs a description" lists them;
 *   3. the API documentation of the entry point that hands the request to the operation (`api`: a controller method
 *      with `@ApiOperation({ description })` whose handler only calls this operation);
 *   4. the doc comment of the operation's class (`class`, set by the backend).
 * An operation with none of these that a described operation only hands over to (controller → facade → worker) gets
 * the facade's description as `context`: shown as "called through …", never as its own, so it still needs one.
 * Applied to the finished graph, so any language backend gets them and a refresh picks up profile edits.
 */
export function describe<G extends Pick<ModuleGraph, 'modules' | 'operations'> & Partial<Pick<ModuleGraph, 'entryPoints' | 'scopes'>>>(g: G, config: Config): G {
  for (const mod of Object.values(g.modules)) {
    const o = overrideFor(config, mod);
    if (o?.summary) Object.assign(mod, { summary: o.summary.replace(/\s+/g, ' '), summarySource: 'profile' });
  }
  for (const op of Object.values(g.operations)) {
    op.context = undefined;
    // The agent's blind check: shown on the operation, never acted on.
    const cls = g.modules[op.moduleId]?.className ?? op.moduleId;
    const doubt = config.disagreements?.[`${cls}.${op.name}`] ?? config.disagreements?.[op.id];
    if (doubt?.length) op.disagreements = doubt.map((d) => ({ line: Number(d.line), note: String(d.note) }));
    else delete op.disagreements;
    if (op.summarySource === 'code') continue;
    const mod = g.modules[op.moduleId];
    const written = mod ? operationText(overrideFor(config, mod), op.name) : undefined;
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
  // A described operation that hands over to another (a facade): context for the one doing the work.
  for (const facade of Object.values(g.operations)) {
    if (!facade.summary || facade.change === 'removed') continue;
    const target = delegate(g.scopes?.[facade.id]);
    const worker = target ? g.operations[target] : undefined;
    if (!worker || worker.summary || worker.id === facade.id) continue;
    worker.context = { from: facade.id, summary: facade.summary };
  }
  return g;
}

/** Reads and lookups a facade may do before it hands over: they prepare arguments, they do no work of their own. */
const LOOKUP = /^(get|find|load|fetch|resolve|read|lookup|to|parse|map)([A-Z]|$)/;

/**
 * The operation a facade hands over to: its only call, or its last call whose result it returns, when everything
 * before it only prepares the arguments (steps of its own private helpers, lookups, reads). Undefined when it does
 * work of its own (a write, a publish, a second call that isn't a lookup).
 */
function delegate(scope: NonNullable<ModuleGraph['scopes']>[string] | undefined): string | undefined {
  const steps = scope?.steps ?? [];
  if (steps.length === 1) return steps[0].kind === 'call' ? steps[0].target : undefined;
  const returned = new Set((scope?.edges ?? []).filter((e) => e.to === 'exit' && e.kind === 'data').map((e) => e.from));
  const last = steps.at(-1);
  if (!last || last.kind !== 'call' || !returned.has(last.id)) return undefined;
  const preparing = steps.slice(0, -1).every((s) =>
    s.kind === 'call' ? !!s.via || LOOKUP.test(s.target?.split('.').at(-1) ?? '') : s.effect?.kind === 'db.read');
  return preparing ? last.target : undefined;
}

/**
 * The profile entry for a module: keyed by its class name (`ShipmentPlanningService`), or by the module id
 * or display name the review shows (`ShipmentPlanning`), in any case. An agent copying a name from the
 * brief's change headlines must not be silently ignored. Several keys for one module are merged (the class name wins).
 */
function overrideFor(config: Config, mod: Pick<ModuleInfo, 'className' | 'id' | 'name'>): ModuleOverride | undefined {
  const order = [mod.className, mod.id, mod.name].map((k) => k.toLowerCase());
  const keys = Object.keys(config.modules.overrides)
    .filter((k) => order.includes(k.toLowerCase()))
    .sort((a, b) => order.indexOf(b.toLowerCase()) - order.indexOf(a.toLowerCase()) || (a === mod.className ? 1 : -1));
  if (!keys.length) return undefined;
  const merged: ModuleOverride = {};
  for (const k of keys) {
    const o = config.modules.overrides[k];
    Object.assign(merged, o, { operations: { ...merged.operations, ...o.operations } });
  }
  return merged;
}

function operationText(o: ModuleOverride | undefined, name: string): string | undefined {
  const ops = o?.operations ?? {};
  return ops[name] ?? Object.entries(ops).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
}

/**
 * Profile descriptions that describe nothing: a class or method no module has. Said in the brief and on the console,
 * so a typo or a wrong key in what the review agent wrote doesn't just vanish. `known` = every module's public
 * methods (`<module id>.<method>`), analyzed or not.
 */
export function unmatchedDescriptions(config: Config, modules: Pick<ModuleInfo, 'className' | 'id' | 'name'>[], known: string[]): string[] {
  const out: string[] = [];
  for (const [key, o] of Object.entries(config.modules.overrides)) {
    if (!o.summary && !Object.keys(o.operations ?? {}).length) continue;
    const mod = modules.find((m) => overrideFor({ ...config, modules: { ...config.modules, overrides: { [key]: o } } }, m));
    if (!mod) {
      out.push(`\`${key}\`: no module of this service has that class name`);
      continue;
    }
    const methods = known.filter((id) => id.startsWith(`${mod.id}.`)).map((id) => id.slice(mod.id.length + 1));
    for (const name of Object.keys(o.operations ?? {})) {
      if (!methods.some((m) => m.toLowerCase() === name.toLowerCase())) out.push(`\`${key}.${name}\`: ${mod.className} has no public method \`${name}\`${methods.length ? ` (it has ${methods.slice(0, 8).join(', ')})` : ''}`);
    }
  }
  return out;
}

/** What `describe` reads from a profile: equal keys = nothing to re-apply. */
export function descriptionsKey(config: Config): string {
  return JSON.stringify([Object.entries(config.modules.overrides).map(([cls, o]) => [cls, o.summary, o.operations]), config.disagreements ?? {}]);
}
