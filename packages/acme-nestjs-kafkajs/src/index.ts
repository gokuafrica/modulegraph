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
export interface KafkaMessage<T> {
  topic: string;
  partition: number;
  offset: string;
  key?: string;
  headers: Record<string, string>;
  value: T;
}

/** Every consumer handler extends this; the service maps consumer names to handler classes. */
export abstract class BaseConsumerHandler<TMessage, TResult = void> {
  abstract handle(message: KafkaMessage<TMessage>): Promise<TResult>;

  protected header(message: KafkaMessage<TMessage>, name: string): string | undefined {
    return message.headers[name];
  }
}

@Injectable()
export class KafkaJsService {
  private readonly kafka: Kafka;
  private producer?: Producer;
  private readonly consumers = new Map<string, Consumer>();

  constructor(@Inject(KAFKA_OPTIONS) private readonly options: AcmeKafkaOptions) {
    const config: KafkaConfig = { clientId: options.clientId, brokers: options.brokers, ssl: options.ssl };
    this.kafka = new Kafka(config);
  }

  async sendMessage(topic: string, messages: Message[]): Promise<void> {
    if (!this.producer) {
      this.producer = this.kafka.producer();
      await this.producer.connect();
    }
    await this.producer.send({ topic, messages });
  }

  /** Starts a consumer group on a topic and hands every decoded message to `onMessage`. */
  async consume<T>(name: string, topic: string, groupId: string, onMessage: (message: KafkaMessage<T>) => Promise<unknown>): Promise<void> {
    const consumer = this.kafka.consumer({ groupId });
    this.consumers.set(name, consumer);
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ topic: t, partition, message }) => {
        const headers = Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [k, String(v)]));
        await onMessage({ topic: t, partition, offset: message.offset, key: message.key?.toString(), headers, value: JSON.parse(message.value?.toString() ?? 'null') as T });
      },
    });
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.consumers.values()].map((c) => c.disconnect()));
    await this.producer?.disconnect();
  }
}

/** Encodes with the registered Avro schema of the topic, then produces. */
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
