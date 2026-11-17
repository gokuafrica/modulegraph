import { Injectable } from '@nestjs/common';
import { AvroKafkaMessage } from '@acme/nestjs-kafkajs';
import { DuplicateRecordsService } from '../../duplicates/services/duplicate-records.service';
import { BaseConsumerHandler } from '../base/base-consumer.handler';
import { ConsumersManagerService } from '../services/consumers-manager.service';
import { RecordDuplicateDetectedMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class RecordDuplicateDetectedHandler extends BaseConsumerHandler<RecordDuplicateDetectedMessage> {
  constructor(
    consumersManager: ConsumersManagerService,
    private readonly duplicateRecordsService: DuplicateRecordsService,
  ) {
    super(consumersManager);
  }

  async handleMessages(messages: AvroKafkaMessage<RecordDuplicateDetectedMessage>[]): Promise<void> {
    for (const { value } of messages) {
      await this.duplicateRecordsService.reportDuplicate(value.recordGuid, value.duplicateOf);
    }
  }
}
