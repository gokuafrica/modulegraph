import { Inject, Injectable, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { Kafka, type Consumer, type KafkaConfig, type Message, type Producer } from 'kafkajs';

export const KAFKA_OPTIONS = 'ACME_KAFKA_OPTIONS';

export interface AcmeKafkaOptions {
  clientId: string;
  brokers: string[];
  schemaRegistryUrl?: string;
  ssl?: boolean;
}

/** A consumed message, already decoded from Avro. */
export interface AvroKafkaMessage<T> {
  topic: string;
  partition: number;
  offset: string;
  key?: string;
  headers: Record<string, string>;
  value: T;
}

/** @deprecated since 3.0: use AvroKafkaMessage. */
export type KafkaMessage<T> = AvroKafkaMessage<T>;

export interface AvroProducerRecord<T> {
  /** Schema registry subject, usually `<topic>-value`. */
  subject: string;
  topic: string;
  messages: { key?: string; value: T; headers?: Record<string, string> }[];
}

export interface ProducerOptions {
  allowAutoTopicCreation?: boolean;
  idempotent?: boolean;
}

/** A producer that encodes every message with the subject's registered Avro schema. */
export class AcmeAvroProducer {
  private connected = false;

  constructor(private readonly producer: Producer) {}

  async send<T extends object>(record: AvroProducerRecord<T>): Promise<void> {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
    await this.producer.send({
      topic: record.topic,
      messages: record.messages.map((m) => ({ key: m.key, headers: { 'x-schema-subject': record.subject, ...m.headers }, value: Buffer.from(JSON.stringify(m.value)) })),
    });
  }

  async disconnect(): Promise<void> {
    if (this.connected) await this.producer.disconnect();
    this.connected = false;
  }
}

@Injectable()
export class KafkaJsService {
  private readonly kafka: Kafka;
  private defaultProducer?: Producer;
  private readonly consumers = new Map<string, Consumer>();
  private readonly producers: AcmeAvroProducer[] = [];

  constructor(@Inject(KAFKA_OPTIONS) private readonly options: AcmeKafkaOptions) {
    const config: KafkaConfig = { clientId: options.clientId, brokers: options.brokers, ssl: options.ssl };
    this.kafka = new Kafka(config);
  }

  /** A new Avro producer; connects on its first send. */
  producer(options: ProducerOptions = {}): AcmeAvroProducer {
    const producer = new AcmeAvroProducer(this.kafka.producer(options));
    this.producers.push(producer);
    return producer;
  }

  /** Plain (JSON) messages through the shared producer. */
  async sendMessage(topic: string, messages: Message[]): Promise<void> {
    if (!this.defaultProducer) {
      this.defaultProducer = this.kafka.producer();
      await this.defaultProducer.connect();
    }
    await this.defaultProducer.send({ topic, messages });
  }

  /** Starts a consumer group on a topic and hands every decoded batch to `onBatch`. */
  async consumeBatch<T>(name: string, topic: string, groupId: string, onBatch: (messages: AvroKafkaMessage<T>[]) => Promise<unknown>): Promise<void> {
    const consumer = this.kafka.consumer({ groupId });
    this.consumers.set(name, consumer);
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });
    await consumer.run({
      eachBatch: async ({ batch }) => {
        await onBatch(
          batch.messages.map((message) => ({
            topic: batch.topic,
            partition: batch.partition,
            offset: message.offset,
            key: message.key?.toString(),
            headers: Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [k, String(v)])),
            value: JSON.parse(message.value?.toString() ?? 'null') as T,
          })),
        );
      },
    });
  }

  isHealthy(): boolean {
    return this.consumers.size > 0 || this.producers.length > 0;
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.consumers.values()].map((c) => c.disconnect()));
    await Promise.all(this.producers.map((p) => p.disconnect()));
    await this.defaultProducer?.disconnect();
  }
}

/** Encodes with the registered Avro schema of the topic, then produces (the 2.x API, kept for existing callers). */
@Injectable()
export class AvroProducer {
  constructor(private readonly kafkaJsService: KafkaJsService) {}

  async send<T extends object>(topic: string, payload: T, key?: string): Promise<void> {
    const value = Buffer.from(JSON.stringify(payload));
    await this.kafkaJsService.sendMessage(topic, [{ key, value }]);
  }
}

@Module({})
export class KafkaJsModule {
  static forRootAsync(options: { inject?: unknown[]; useFactory: (...args: never[]) => AcmeKafkaOptions | Promise<AcmeKafkaOptions> }): DynamicModule {
    const providers: Provider[] = [
      { provide: KAFKA_OPTIONS, useFactory: options.useFactory, inject: (options.inject ?? []) as never[] },
      KafkaJsService,
      AvroProducer,
    ];
    return { module: KafkaJsModule, global: true, providers, exports: [KafkaJsService, AvroProducer] };
  }
}
