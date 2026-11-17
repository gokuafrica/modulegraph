import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecordMetadata } from '@nestjs/microservices/external/kafka.interface';
import { AcmeAvroProducer, KafkaJsService } from '@acme/nestjs-kafkajs';
import { KafkaTopicsConfig } from '../../config/configuration';

export interface AuditEventSchema {
  recordGuid: string;
  action: string;
  actorGuid: string;
  occurredAt: string;
}

/** Publishes audit events for the data warehouse. */
@Injectable()
export class AuditEventsPublisher {
  private readonly topic: string;
  private readonly producer: AcmeAvroProducer;
  private lastSent?: RecordMetadata[];

  constructor(kafkaService: KafkaJsService, configService: ConfigService) {
    this.topic = configService.get<KafkaTopicsConfig>('KAFKA_TOPICS').AUDIT_EVENTS;
    this.producer = kafkaService.producer({ allowAutoTopicCreation: false });
  }

  async publish(event: AuditEventSchema): Promise<void> {
    await this.producer.send<AuditEventSchema>({ subject: `${this.topic}-value`, topic: this.topic, messages: [{ key: event.recordGuid, value: event }] });
  }

  /** For replays and local testing: any topic, any payload. */
  async publishRaw(parameters: { topic: string; key: string; value: object }): Promise<void> {
    await this.producer.send({ subject: `${parameters.topic}-value`, topic: parameters.topic, messages: [{ key: parameters.key, value: parameters.value }] });
  }

  sentSinceStart(): RecordMetadata[] | undefined {
    return this.lastSent;
  }
}
