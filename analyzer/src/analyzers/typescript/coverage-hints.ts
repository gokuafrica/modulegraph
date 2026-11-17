/**
 * Signs that an analysis is probably missing entry points or side effects, read from the project's package.json and
 * installed packages. The extractor combines them with what it found in the code (handler maps, `process.argv`) into
 * `missing-entry-points` / `unknown-side-effects` issues, each with the profile rule that would fix it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Message brokers and queues: a service that depends on one usually consumes from it too. */
export const MESSAGING_PACKAGES = ['kafkajs', '@confluentinc/kafka-javascript', 'node-rdkafka', 'amqplib', 'amqp-connection-manager', 'bullmq', 'bull', 'nats', '@aws-sdk/client-sqs', '@aws-sdk/client-sns', '@google-cloud/pubsub', '@azure/service-bus', 'ioredis', 'redis'];
/** Packages whose clients consume messages (Kafka, AMQP, SQS, Pub/Sub): no consumer entry point is suspicious. */
export const CONSUMER_PACKAGES = new Set(['kafkajs', '@confluentinc/kafka-javascript', 'node-rdkafka', 'amqplib', 'amqp-connection-manager', 'nats', '@aws-sdk/client-sqs', '@google-cloud/pubsub', '@azure/service-bus']);
/** Package names that say "side effects" (a producer, an outbox, a queue, a cloud client). */
export const EFFECT_NAME = /kafka|outbox|queue|producer|publisher|pubsub|\bsqs\b|\bsns\b|rabbit|amqp|\bnats\b|event-?bus|kinesis|\bmq\b|@aws-sdk\/client-|@google-cloud\/|@azure\//i;
/** Method names that do something outside the process (as opposed to connect, consume, get, …). */
export const EFFECT_METHOD = /^(send|publish|produce|emit|write|enqueue|add|put|dispatch|notify|insert|upsert|update|delete|remove|encrypt|decrypt|sign|upload|invoke|execute)/i;

export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export function readPackageJson(dir: string): PackageJson {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return {};
  }
}

/** The installed package.json of a dependency (node_modules in the project folder or above it). */
export function installedPackage(projectDir: string, pkg: string): PackageJson | undefined {
  for (let dir = projectDir; ; dir = dirname(dir)) {
    const file = join(dir, 'node_modules', pkg, 'package.json');
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
      } catch {
        return undefined;
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Messaging packages a dependency is built on (`@acme/nestjs-kafkajs` → kafkajs). */
export function wraps(projectDir: string, pkg: string): string[] {
  const p = installedPackage(projectDir, pkg);
  if (!p) return [];
  const deps = new Set([...Object.keys(p.dependencies ?? {}), ...Object.keys(p.peerDependencies ?? {})]);
  return MESSAGING_PACKAGES.filter((m) => deps.has(m));
}

/**
 * Scripts that start the app with an extra argument, the usual way to run a job, poller or backfill from the same
 * code (`"start:some-poller": "nest start -- some-poller"`, `node dist/main some-backfill`). Script name → argument.
 */
export function argvScripts(pkg: PackageJson): { script: string; command: string; arg: string }[] {
  const out: { script: string; command: string; arg: string }[] = [];
  for (const [script, command] of Object.entries(pkg.scripts ?? {})) {
    const tokens = command.split('&&').at(-1)!.trim().split(/\s+/);
    let i = -1;
    const nest = tokens.findIndex((t, k) => t === 'nest' && tokens[k + 1] === 'start');
    if (nest >= 0) i = nest + 2;
    else {
      const main = tokens.findIndex((t) => /(^|\/)main(\.[cm]?[jt]s)?$/.test(t));
      if (main >= 0 && tokens.slice(0, main).some((t) => /^(node|ts-node|tsx|nodemon)$/.test(t) || /\/(node|ts-node|tsx)$/.test(t))) i = main + 1;
    }
    if (i < 0) continue;
    // `nest start -- x`: the argument after `--`; flags (`--watch`, `--debug`) and their values don't count.
    const rest = tokens.slice(i);
    const dashes = rest.indexOf('--');
    const candidates = dashes >= 0 ? rest.slice(dashes + 1) : nest >= 0 ? [] : rest;
    const arg = candidates.find((t) => !t.startsWith('-'));
    if (arg && /^[\w:.-]+$/.test(arg)) out.push({ script, command, arg });
  }
  return out;
}

/** What kind of entry point a registry most likely holds, from its name and its classes' base class. */
export function registryKind(text: string): 'consumer' | 'queue' | 'cron' | 'event' {
  if (/job|cron|schedul|poller|backfill/i.test(text)) return 'cron';
  if (/queue|worker|task/i.test(text)) return 'queue';
  if (/listener|event/i.test(text) && !/consum|kafka|topic/i.test(text)) return 'event';
  return 'consumer';
}

/** The side effect a client method most likely is, for a suggested sink rule. */
export function sinkKind(pkg: string, owner: string): 'kafka' | 'outbox' | 'queue' | 'http' | 'event' {
  const text = `${pkg} ${owner}`;
  if (/outbox/i.test(text)) return 'outbox';
  if (/kafka|avro|producer/i.test(text)) return 'kafka';
  if (/queue|sqs|bull|amqp|rabbit|job/i.test(text)) return 'queue';
  if (/event-?bus|publisher|pubsub|sns|eventbridge/i.test(text)) return 'event';
  return 'http';
}
