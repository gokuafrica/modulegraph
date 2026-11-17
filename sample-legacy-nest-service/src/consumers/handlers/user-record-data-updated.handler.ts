import { Injectable } from '@nestjs/common';
import { AvroKafkaMessage } from '@acme/nestjs-kafkajs';
import { ManualReviewService } from '../../manual-review/services/manual-review.service';
import { BaseConsumerHandler } from '../base/base-consumer.handler';
import { ConsumersManagerService } from '../services/consumers-manager.service';
import { UserRecordDataUpdatedMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class UserRecordDataUpdatedHandler extends BaseConsumerHandler<UserRecordDataUpdatedMessage> {
  constructor(
    consumersManager: ConsumersManagerService,
    private readonly manualReviewService: ManualReviewService,
  ) {
    super(consumersManager);
  }

  async handleMessages(messages: AvroKafkaMessage<UserRecordDataUpdatedMessage>[]): Promise<void> {
    for (const { value } of messages) {
      await this.manualReviewService.updateUserRecordData(value.agentGuid, value.guid, { data: value.data, reason: value.reason ?? 'updated by review-tools' });
    }
  }
}
