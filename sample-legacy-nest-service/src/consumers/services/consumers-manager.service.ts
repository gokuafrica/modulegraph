import { Injectable, OnApplicationShutdown, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AvroKafkaMessage, KafkaJsService } from '@acme/nestjs-kafkajs';
import { AcmeLogger } from '@acme/nestjs-logging';
import { ConsumerConfig } from '../../config/configuration';
import { MetricsService } from '../../metrics/services/metrics.service';
import type { BaseConsumerHandler } from '../base/base-consumer.handler';

@Injectable()
export class ConsumersManagerService implements OnApplicationShutdown {
  private readonly handlers = new Map<Function, BaseConsumerHandler<unknown, unknown>>();

  constructor(
    private readonly kafkaJsService: KafkaJsService,
    private readonly configService: ConfigService,
    private readonly metricsService: MetricsService,
    private readonly logger: AcmeLogger,
  ) {}

  addHandler(handler: BaseConsumerHandler<any, any>) {
    this.handlers.set(handler.constructor, handler);
  }

  /** Starts the consumers of these handler classes (main.ts picks them from the command line). */
  async start(handlerTypes: Type<BaseConsumerHandler<any, any>>[]) {
    const consumers = this.configService.get<ConsumerConfig[]>('kafka.consumers') ?? [];
    for (const handlerType of handlerTypes) {
      const consumer = consumers.find((c) => c.handler === handlerType.name);
      const handler = this.handlers.get(handlerType);
      if (!consumer || !handler) {
        this.logger.warn(`No consumer configured for ${handlerType.name}`);
        continue;
      }
      await this.kafkaJsService.consumeBatch(consumer.name, consumer.topic, consumer.groupId, async (messages: AvroKafkaMessage<unknown>[]) => {
        try {
          await handler.handleMessages(messages);
          this.metricsService.recordKafkaMessage(consumer.name, 'ok');
        } catch (error) {
          this.metricsService.recordKafkaMessage(consumer.name, 'failed');
          this.logger.error(`Consumer ${consumer.name} failed`, error);
          throw error;
        }
      });
    }
  }

  async onApplicationShutdown() {
    await this.kafkaJsService.disconnect();
  }
}
