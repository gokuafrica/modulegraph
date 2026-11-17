import { Injectable } from '@nestjs/common';
import { AvroKafkaMessage } from '@acme/nestjs-kafkajs';
import { AuditEventsPublisher } from '../../audit-log/services/audit-events.publisher';
import { BaseConsumerHandler } from '../base/base-consumer.handler';
import { ConsumersManagerService } from '../services/consumers-manager.service';
import { RiskScoreChangedMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class RiskScoreChangedHandler extends BaseConsumerHandler<RiskScoreChangedMessage> {
  constructor(
    consumersManager: ConsumersManagerService,
    private readonly auditEventsPublisher: AuditEventsPublisher,
  ) {
    super(consumersManager);
  }

  async handleMessages(messages: AvroKafkaMessage<RiskScoreChangedMessage>[]): Promise<void> {
    for (const { value } of messages) {
      await this.auditEventsPublisher.publish({ recordGuid: value.recordGuid, action: 'RISK_SCORE_CHANGED', actorGuid: 'risk-engine', occurredAt: value.changedAt });
    }
  }
}
