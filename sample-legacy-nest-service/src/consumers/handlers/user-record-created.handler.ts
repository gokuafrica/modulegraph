import { Injectable } from '@nestjs/common';
import { BaseConsumerHandler, KafkaMessage } from '@acme/nestjs-kafkajs';
import { UserRecordService } from '../../user-records/services/user-record.service';
import { UserRecordCreatedMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class UserRecordCreatedHandler extends BaseConsumerHandler<UserRecordCreatedMessage, void> {
  constructor(private readonly userRecordService: UserRecordService) {
    super();
  }

  async handle(message: KafkaMessage<UserRecordCreatedMessage>): Promise<void> {
    await this.userRecordService.create(message.value);
  }
}
