import { Injectable } from '@nestjs/common';
import { BaseConsumerHandler, KafkaMessage } from '@acme/nestjs-kafkajs';
import { ManualReviewService } from '../../manual-review/services/manual-review.service';
import { UserRecordDataUpdatedMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class UserRecordDataUpdatedHandler extends BaseConsumerHandler<UserRecordDataUpdatedMessage, void> {
  constructor(private readonly manualReviewService: ManualReviewService) {
    super();
  }

  async handle(message: KafkaMessage<UserRecordDataUpdatedMessage>): Promise<void> {
    const { guid, agentGuid, data, reason } = message.value;
    await this.manualReviewService.updateUserRecordData(agentGuid, guid, { data, reason: reason ?? 'updated by review-tools' });
  }
}
