import { Node } from 'ts-morph';
import type { Framework } from './types.ts';

/**
 * KafkaJS: `producer.send({ topic })` is a Kafka effect; `consumer.run({ eachMessage })` is an entry point whose
 * label lists the topics the same consumer subscribed to (`consumer.subscribe({ topics: [...] })`).
 */
export const kafkajs: Framework = {
  id: 'kafkajs',
  name: 'KafkaJS',
  packages: ['kafkajs'],
  sinks: [
    { class: 'Sender|Producer|Transaction', module: 'kafkajs', method: 'send', kind: 'kafka', target: 'arg:0.topic' },
    { class: 'Sender|Producer|Transaction', module: 'kafkajs', method: 'sendBatch', kind: 'kafka', target: 'const:batch' },
  ],
  entryPoints: [
    { class: 'Consumer', module: 'kafkajs', method: 'run', kind: 'consumer', label: 'topic {topics}', handler: 'arg:0.eachMessage|arg:0.eachBatch' },
  ],
  hooks: {
    entryVars(site, ctx) {
      if (site.owner !== 'Consumer' || site.name !== 'run' || !site.receiver) return undefined;
      const consumer = ctx.resolve(site.receiver);
      const topics: string[] = [];
      for (const sub of ctx.callsNamed('subscribe')) {
        const expr = sub.getExpression();
        if (!Node.isPropertyAccessExpression(expr) || ctx.resolve(expr.getExpression()) !== consumer) continue;
        const opts = sub.getArguments()[0];
        if (!opts || !Node.isObjectLiteralExpression(opts)) continue;
        for (const name of ['topic', 'topics']) {
          const p = opts.getProperty(name);
          if (p && Node.isPropertyAssignment(p)) topics.push(ctx.literal(p.getInitializer()));
        }
      }
      return { topics: topics.join(', ') || '?' };
    },
  },
};

/** BullMQ: `queue.add(name, data)` enqueues a job on the queue the receiver was built or injected with; `new Worker('q', fn)` handles them. */
export const bullmq: Framework = {
  id: 'bullmq',
  name: 'BullMQ',
  packages: ['bullmq', 'bull', '@nestjs/bullmq', '@nestjs/bull'],
  sinks: [{ class: 'Queue', module: 'bullmq|bull', method: ['add', 'addBulk'], kind: 'queue', target: 'injected|receiver' }],
  entryPoints: [{ class: 'Worker', module: 'bullmq', method: 'new', kind: 'queue', label: 'queue {0}', handler: 'arg:1' }],
};

/** node-cron: `cron.schedule('0 3 * * *', fn, { name })`. */
export const nodeCron: Framework = {
  id: 'node-cron',
  name: 'node-cron',
  packages: ['node-cron'],
  entryPoints: [{ module: 'node-cron', method: 'schedule', kind: 'cron', label: 'cron {2.name|handlerName|at} ({0})', handler: 'arg:1' }],
};
