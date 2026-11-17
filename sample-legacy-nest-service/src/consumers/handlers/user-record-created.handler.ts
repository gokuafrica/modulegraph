import { Injectable } from '@nestjs/common';
import { AvroKafkaMessage } from '@acme/nestjs-kafkajs';
import { UserRecordService } from '../../user-records/services/user-record.service';
import { BaseConsumerHandler } from '../base/base-consumer.handler';
import { ConsumersManagerService } from '../services/consumers-manager.service';
import { UserRecordCreatedMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class UserRecordCreatedHandler extends BaseConsumerHandler<UserRecordCreatedMessage> {
  constructor(
    consumersManager: ConsumersManagerService,
    private readonly userRecordService: UserRecordService,
  ) {
    super(consumersManager);
  }

  async handleMessages(messages: AvroKafkaMessage<UserRecordCreatedMessage>[]): Promise<void> {
    for (const { value } of messages) {
      await this.userRecordService.create(value);
    }
  }
}
