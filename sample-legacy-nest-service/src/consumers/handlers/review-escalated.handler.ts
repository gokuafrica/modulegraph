import { Injectable } from '@nestjs/common';
import { AvroKafkaMessage } from '@acme/nestjs-kafkajs';
import { EscalationsService } from '../../escalations/services/escalations.service';
import { BaseConsumerHandler } from '../base/base-consumer.handler';
import { ConsumersManagerService } from '../services/consumers-manager.service';
import { ReviewEscalatedMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class ReviewEscalatedHandler extends BaseConsumerHandler<ReviewEscalatedMessage> {
  constructor(
    consumersManager: ConsumersManagerService,
    private readonly escalationsService: EscalationsService,
  ) {
    super(consumersManager);
  }

  async handleMessages(messages: AvroKafkaMessage<ReviewEscalatedMessage>[]): Promise<void> {
    for (const { value } of messages) {
      await this.escalationsService.open(value.recordGuid, value.reason, value.escalatedBy);
    }
  }
}
