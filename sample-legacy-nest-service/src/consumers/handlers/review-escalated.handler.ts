import { Injectable } from '@nestjs/common';
import { BaseConsumerHandler, KafkaMessage } from '@acme/nestjs-kafkajs';
import { EscalationsService } from '../../escalations/services/escalations.service';
import { ReviewEscalatedMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class ReviewEscalatedHandler extends BaseConsumerHandler<ReviewEscalatedMessage, void> {
  constructor(private readonly escalationsService: EscalationsService) {
    super();
  }

  async handle(message: KafkaMessage<ReviewEscalatedMessage>): Promise<void> {
    const { recordGuid, reason, escalatedBy } = message.value;
    await this.escalationsService.open(recordGuid, reason, escalatedBy);
  }
}
