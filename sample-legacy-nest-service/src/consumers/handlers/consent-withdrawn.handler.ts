import { Injectable } from '@nestjs/common';
import { AvroKafkaMessage } from '@acme/nestjs-kafkajs';
import { AuditLogService } from '../../audit-log/services/audit-log.service';
import { BaseConsumerHandler } from '../base/base-consumer.handler';
import { ConsumersManagerService } from '../services/consumers-manager.service';
import { RecordEventMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class ConsentWithdrawnHandler extends BaseConsumerHandler<RecordEventMessage> {
  constructor(
    consumersManager: ConsumersManagerService,
    private readonly auditLogService: AuditLogService,
  ) {
    super(consumersManager);
  }

  async handleMessages(messages: AvroKafkaMessage<RecordEventMessage>[]): Promise<void> {
    for (const { value } of messages) {
      await this.auditLogService.record(value.recordGuid, 'CONSENT_WITHDRAWN', value.actorGuid, value.details);
    }
  }
}
