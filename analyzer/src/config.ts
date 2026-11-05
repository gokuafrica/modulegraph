import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { EffectKind, EntryKind } from '../../schema/modulegraph.ts';

/**
 * Which calls a rule matches. `class` is the declaring class, interface or type alias (`Db`, `Repository`,
 * `IRouter`); `module` is the npm package it comes from (`node-cron`, `global` for built-ins such as fetch).
 * Both accept alternatives separated by `|`; `method` also accepts a list. `method: "new"` matches `new Class(…)`.
 */
export interface CallMatch {
  class?: string;
  module?: string;
  method: string | string[];
}

/**
 * Maps a platform method to a side effect. The table/topic/service name comes from `target` (default: the
 * literal argument `targetArg`, or 0):
 * - `arg:N` literal argument N; `arg:N.prop` property of an object argument (`arg:0.topic`)
 * - `url:N` host (or path) of a URL argument
 * - `entity` the entity behind `Repository<Order>` (TypeORM `@Entity('orders')`, else the class name)
 * - `model` a Mongoose model's collection (`@InjectModel(Order.name)`, `model('Order', …)`)
 * - `injected` the name the receiver was injected or built with (`@InjectQueue('emails')`, `new Queue('emails')`)
 * - `receiver` the receiver's property name; `const:<name>` a fixed name
 * Alternatives: `injected|arg:0`.
 */
export interface SinkRule extends CallMatch {
  kind: EffectKind;
  targetArg?: number;
  target?: string;
}

/**
 * Maps a framework registration call to an entry point. `label` fills `{N}` / `{N.prop}` from literal
 * arguments and `{verb}` / `{path}` / `{topics}` / `{handlerName}` / `{at}` from the call; `{a|b}` takes the first
 * that exists. `handler` says where the handler function is: `arg:N`, `arg:N.prop`, `last` (default: `handlerArg`, or 1).
 */
export interface EntryRule extends CallMatch {
  kind: EntryKind;
  label: string;
  handlerArg?: number;
  handler?: string;
  readOnly?: boolean;
}

/**
 * Decorator-based handlers (NestJS and similar). A method is an entry point when it carries `decorator`
 * imported from `from`, inside a class carrying `classDecorator` (if given). Without `decorator`, the class
 * decorator marks the method named `method` (BullMQ's `process`). Label variables: `{N}` decorator arguments,
 * `{class.N}` class decorator arguments, `{verb}`, `{path}` (global prefix + class path + method path),
 * `{class}`, `{method}`, `{Method}`.
 */
export interface DecoratorEntryRule {
  decorator?: string;
  from: string;
  classDecorator?: string;
  method?: string;
  kind: EntryKind;
  label: string;
  readOnly?: boolean;
}

/** A call whose argument is the handler's response (`res.json(x)`): it feeds the exit like a `return`. */
export interface ResponseRule extends CallMatch {
  arg: number;
}

/** Per-module facts an agent (or a person) supplies from outside the repo. All optional. */
export interface ModuleOverride {
  /** Display name, e.g. "BirthInfo". Default: class name without a Module/Service suffix. */
  name?: string;
  owner?: string;
  summary?: string;
  /**
   * What each method does, by method name, for methods without a doc comment. The review agent writes these
   * (the brief lists the ones a review needs); the code's own doc comment wins when there is one.
   */
  operations?: Record<string, string>;
  /** Declared direct side effects, e.g. "outbox birth_info.source_resolved". Enables the undeclared-effect rule. */
  effects?: string[];
}

/**
 * Lives outside the analyzed repo (pass --config). The analyzed code is never modified: modules are found from its
 * structure, and everything the code doesn't say explicitly (which classes talk to the DB/Kafka/HTTP, who owns what)
 * is described here.
 */
export interface Config {
  service: string;
  /** Language backend (default: detected, e.g. "typescript"). */
  analyzer?: string;
  /** Framework adapters to use (default: detected from package.json, e.g. ["nestjs", "typeorm"]). */
  frameworks?: string[];
  tsconfig: string;
  /** Optional opt-in for teams that do want in-code markers: a JSDoc tag that forces a class to be a module. */
  moduleTag: string;
  modules: {
    /** Force these classes in, even if discovery misses them. */
    include: string[];
    /** Keep these classes out (DTOs, utilities that discovery picked up). */
    exclude: string[];
    overrides: Record<string, ModuleOverride>;
  };
  /** Path glob (repo-relative) -> owner. CODEOWNERS in the repo, if any, is read as a fallback. */
  owners: Record<string, string>;
  /** Platform-specific rules for code the framework adapters don't know. They are added to the adapters' rules. */
  sinks: SinkRule[];
  entryPoints: EntryRule[];
  decoratorEntries: DecoratorEntryRule[];
  responses: ResponseRule[];
  rules: {
    /** Operations that must run at most once per flow (expensive fetches meant to be shared). */
    fetchOnce: string[];
    /** table -> owning module id. Writes from any other module are errors. */
    tableOwners: Record<string, string>;
    requireDeclaredEffects: boolean;
    budget: { maxContractChanges: number; maxChangedLines: number; maxFiles: number };
  };
}

export const defaultConfig: Config = {
  service: 'service',
  tsconfig: 'tsconfig.json',
  moduleTag: 'module',
  modules: { include: [], exclude: [], overrides: {} },
  owners: {},
  sinks: [],
  entryPoints: [],
  decoratorEntries: [],
  responses: [],
  rules: {
    fetchOnce: [],
    tableOwners: {},
    requireDeclaredEffects: true,
    budget: { maxContractChanges: 5, maxChangedLines: 400, maxFiles: 20 },
  },
};

/**
 * Finds the service's profile without being told: the profile whose `service` (or folder name) equals the analyzed
 * project's package name, in the first of `configsDirs` that has one (your modulegraph home, then the demos').
 * Agents never have to guess a path.
 */
export function findProfile(projectDir: string, configsDirs: string[]): { config?: string; scenario?: string; tried: string; name: string } {
  const pkg = join(projectDir, 'package.json');
  const name = existsSync(pkg) ? (JSON.parse(readFileSync(pkg, 'utf8')).name as string) : basename(projectDir);
  const tried = `${configsDirs.map((d) => `${d}/*/modulegraph.config.json`).join(', ')} with service "${name}"`;
  for (const configsDir of configsDirs) {
    if (!existsSync(configsDir)) continue;
    for (const dir of readdirSync(configsDir)) {
      const file = join(configsDir, dir, 'modulegraph.config.json');
      if (!existsSync(file)) continue;
      const service = (JSON.parse(readFileSync(file, 'utf8')) as { service?: string }).service;
      if (service === name || dir === name) {
        const scenario = join(configsDir, dir, 'scenario.ts');
        return { config: file, scenario: existsSync(scenario) ? scenario : undefined, tried, name };
      }
    }
  }
  return { tried, name };
}

/** `configPath` (outside the repo) wins; an in-repo modulegraph.config.json is only an opt-in fallback. */
export function loadConfig(projectDir: string, configPath?: string): Config {
  const file = configPath ?? join(projectDir, 'modulegraph.config.json');
  const pkg = join(projectDir, 'package.json');
  const service = existsSync(pkg) ? (JSON.parse(readFileSync(pkg, 'utf8')).name as string) : defaultConfig.service;
  if (!existsSync(file)) {
    if (configPath) throw new Error(`config not found: ${configPath}`);
    return { ...defaultConfig, service };
  }
  const user = JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>;
  return {
    ...defaultConfig,
    service,
    ...user,
    modules: { ...defaultConfig.modules, ...user.modules },
    owners: user.owners ?? {},
    sinks: user.sinks ?? defaultConfig.sinks,
    entryPoints: user.entryPoints ?? defaultConfig.entryPoints,
    decoratorEntries: user.decoratorEntries ?? [],
    responses: user.responses ?? [],
    rules: { ...defaultConfig.rules, ...user.rules, budget: { ...defaultConfig.rules.budget, ...user.rules?.budget } },
  };
}
