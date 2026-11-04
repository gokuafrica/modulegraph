import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { EffectKind, EntryKind } from '../../schema/modulegraph.ts';

/** Maps a platform method to a side effect. `targetArg` is the argument holding the table/topic/service name. */
export interface SinkRule {
  class: string;
  method: string;
  kind: EffectKind;
  targetArg: number;
}

/** Maps a framework registration call to an entry point. `label` interpolates literal args: "GET {0}". */
export interface EntryRule {
  class: string;
  method: string;
  kind: EntryKind;
  label: string;
  handlerArg: number;
  readOnly?: boolean;
}

/** Per-module facts an agent (or a person) supplies from outside the repo. All optional. */
export interface ModuleOverride {
  /** Display name, e.g. "BirthInfo". Default: class name without a Module/Service suffix. */
  name?: string;
  owner?: string;
  summary?: string;
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
  sinks: SinkRule[];
  entryPoints: EntryRule[];
  rules: {
    /** Operations that must run at most once per flow (expensive fetches meant to be shared). */
    fetchOnce: string[];
    /** table -> owning module id. Writes from any other module are errors. */
    tableOwners: Record<string, string>;
    requireDeclaredEffects: boolean;
    budget: { maxContractChanges: number; maxChangedLines: number; maxFiles: number };
  };
}

const http = (method: string, readOnly: boolean): EntryRule => ({
  class: 'HttpRouter', method, kind: 'api', label: `${method.toUpperCase()} {0}`, handlerArg: 1, readOnly,
});

export const defaultConfig: Config = {
  service: 'service',
  tsconfig: 'tsconfig.json',
  moduleTag: 'module',
  modules: { include: [], exclude: [], overrides: {} },
  owners: {},
  sinks: [
    { class: 'Db', method: 'select', kind: 'db.read', targetArg: 0 },
    { class: 'Db', method: 'insert', kind: 'db.write', targetArg: 0 },
    { class: 'Db', method: 'update', kind: 'db.write', targetArg: 0 },
    { class: 'Db', method: 'delete', kind: 'db.write', targetArg: 0 },
    { class: 'Outbox', method: 'enqueue', kind: 'outbox', targetArg: 0 },
    { class: 'KafkaProducer', method: 'produce', kind: 'kafka', targetArg: 0 },
    { class: 'HttpClient', method: 'get', kind: 'http', targetArg: 0 },
    { class: 'HttpClient', method: 'post', kind: 'http', targetArg: 0 },
  ],
  entryPoints: [
    http('get', true),
    http('post', false),
    http('put', false),
    http('delete', false),
    { class: 'GrpcServer', method: 'unary', kind: 'grpc', label: 'gRPC {0}', handlerArg: 1 },
    { class: 'KafkaConsumer', method: 'subscribe', kind: 'consumer', label: 'topic {0}', handlerArg: 1 },
    { class: 'Scheduler', method: 'cron', kind: 'cron', label: 'cron {0} ({1})', handlerArg: 2 },
  ],
  rules: {
    fetchOnce: [],
    tableOwners: {},
    requireDeclaredEffects: true,
    budget: { maxContractChanges: 5, maxChangedLines: 400, maxFiles: 20 },
  },
};

/**
 * Finds the service's profile in this repo's `configs/` folder without being told: the profile whose `service`
 * (or folder name) equals the analyzed project's package name. Agents never have to guess a path.
 */
export function findProfile(projectDir: string, configsDir: string): { config?: string; scenario?: string; tried: string } {
  const pkg = join(projectDir, 'package.json');
  const name = existsSync(pkg) ? (JSON.parse(readFileSync(pkg, 'utf8')).name as string) : basename(projectDir);
  const tried = `configs/*/modulegraph.config.json with service "${name}"`;
  if (!existsSync(configsDir)) return { tried };
  for (const dir of readdirSync(configsDir)) {
    const file = join(configsDir, dir, 'modulegraph.config.json');
    if (!existsSync(file)) continue;
    const service = (JSON.parse(readFileSync(file, 'utf8')) as { service?: string }).service;
    if (service === name || dir === name) {
      const scenario = join(configsDir, dir, 'scenario.ts');
      return { config: file, scenario: existsSync(scenario) ? scenario : undefined, tried };
    }
  }
  return { tried };
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
    rules: { ...defaultConfig.rules, ...user.rules, budget: { ...defaultConfig.rules.budget, ...user.rules?.budget } },
  };
}
