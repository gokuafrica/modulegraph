import { Injectable } from '@nestjs/common';
import { AvroKafkaMessage } from '@acme/nestjs-kafkajs';
import { TagsService } from '../../tags/services/tags.service';
import { BaseConsumerHandler } from '../base/base-consumer.handler';
import { ConsumersManagerService } from '../services/consumers-manager.service';
import { RecordTagMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class TagRemovedHandler extends BaseConsumerHandler<RecordTagMessage> {
  constructor(
    consumersManager: ConsumersManagerService,
    private readonly tagsService: TagsService,
  ) {
    super(consumersManager);
  }

  async handleMessages(messages: AvroKafkaMessage<RecordTagMessage>[]): Promise<void> {
    for (const { value } of messages) {
      await this.tagsService.removeTag(value.recordGuid, value.tag);
    }
  }
}
