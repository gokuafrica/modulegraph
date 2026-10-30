import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

export interface Config {
  service: string;
  tsconfig: string;
  /** JSDoc tag that marks a class as a module. */
  moduleTag: string;
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

export function loadConfig(projectDir: string): Config {
  const file = join(projectDir, 'modulegraph.config.json');
  if (!existsSync(file)) return defaultConfig;
  const user = JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>;
  return {
    ...defaultConfig,
    ...user,
    sinks: user.sinks ?? defaultConfig.sinks,
    entryPoints: user.entryPoints ?? defaultConfig.entryPoints,
    rules: { ...defaultConfig.rules, ...user.rules, budget: { ...defaultConfig.rules.budget, ...user.rules?.budget } },
  };
}
