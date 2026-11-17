import { AvroKafkaMessage } from '@acme/nestjs-kafkajs';
import { AuditLogService } from '../../audit-log/services/audit-log.service';
import type { ConsumersManagerService } from '../services/consumers-manager.service';
import { SyncFeatureMessage } from '../dto/consumer-messages.dto';
import { BaseConsumerHandler } from './base-consumer.handler';

/** Feature syncs from review-tools: only the latest message per record in a batch counts. */
export abstract class SyncFeatureBaseHandler<T extends SyncFeatureMessage> extends BaseConsumerHandler<T> {
  protected abstract readonly feature: string;

  protected constructor(
    consumersManager: ConsumersManagerService,
    protected readonly auditLogService: AuditLogService,
  ) {
    super(consumersManager);
  }

  async handleMessages(messages: AvroKafkaMessage<T>[]): Promise<void> {
    const latest = new Map<string, T>();
    for (const { value } of messages) {
      latest.set(value.recordGuid, value);
    }
    for (const message of latest.values()) {
      await this.syncFeature(message);
      await this.auditLogService.record(message.recordGuid, `FEATURE_SYNCED:${this.feature}`, 'feature-sync');
    }
  }

  protected abstract syncFeature(message: T): Promise<void>;
}
