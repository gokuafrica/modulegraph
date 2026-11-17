import { Injectable } from '@nestjs/common';
import { AvroKafkaMessage } from '@acme/nestjs-kafkajs';
import { EscalationsService } from '../../escalations/services/escalations.service';
import { BaseConsumerHandler } from '../base/base-consumer.handler';
import { ConsumersManagerService } from '../services/consumers-manager.service';
import { RecordEventMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class EscalationRequestedHandler extends BaseConsumerHandler<RecordEventMessage> {
  constructor(
    consumersManager: ConsumersManagerService,
    private readonly escalationsService: EscalationsService,
  ) {
    super(consumersManager);
  }

  async handleMessages(messages: AvroKafkaMessage<RecordEventMessage>[]): Promise<void> {
    for (const { value } of messages) {
      await this.escalationsService.open(value.recordGuid, 'requested by review-tools', value.actorGuid);
    }
  }
}
