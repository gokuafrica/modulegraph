import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { KafkaJsService } from '@acme/nestjs-kafkajs';
import { AcmeLogger } from '@acme/nestjs-logging';
import { ConsumerConfig } from '../../config/configuration';
import { MetricsService } from '../../metrics/services/metrics.service';
import { ConsumerHandlerMap } from '../consumer-handler.map';

@Injectable()
export class ConsumersManagerService implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly kafkaJsService: KafkaJsService,
    private readonly moduleRef: ModuleRef,
    private readonly configService: ConfigService,
    private readonly metricsService: MetricsService,
    private readonly logger: AcmeLogger,
  ) {}

  async onApplicationBootstrap() {
    const consumers = this.configService.get<ConsumerConfig[]>('kafka.consumers') ?? [];
    for (const consumer of consumers.filter((c) => c.enabled)) {
      await this.startConsumer(consumer);
    }
  }

  async onApplicationShutdown() {
    await this.kafkaJsService.disconnect();
  }

  private async startConsumer(consumer: ConsumerConfig) {
    const handlerType = ConsumerHandlerMap.get(consumer.name);
    if (!handlerType) {
      this.logger.warn(`No handler registered for consumer ${consumer.name}`);
      return;
    }
    const handler = this.moduleRef.get(handlerType, { strict: false });
    await this.kafkaJsService.consume(consumer.name, consumer.topic, consumer.groupId, async (message) => {
      try {
        await handler.handle(message);
        this.metricsService.recordKafkaMessage(consumer.name, 'ok');
      } catch (error) {
        this.metricsService.recordKafkaMessage(consumer.name, 'failed');
        this.logger.error(`Consumer ${consumer.name} failed`, error);
        throw error;
      }
    });
  }
}
