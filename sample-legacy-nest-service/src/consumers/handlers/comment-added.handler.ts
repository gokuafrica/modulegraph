import { Injectable } from '@nestjs/common';
import { AvroKafkaMessage } from '@acme/nestjs-kafkajs';
import { CommentsService } from '../../comments/services/comments.service';
import { BaseConsumerHandler } from '../base/base-consumer.handler';
import { ConsumersManagerService } from '../services/consumers-manager.service';
import { CommentAddedMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class CommentAddedHandler extends BaseConsumerHandler<CommentAddedMessage> {
  constructor(
    consumersManager: ConsumersManagerService,
    private readonly commentsService: CommentsService,
  ) {
    super(consumersManager);
  }

  async handleMessages(messages: AvroKafkaMessage<CommentAddedMessage>[]): Promise<void> {
    for (const { value } of messages) {
      await this.commentsService.addComment(value.recordGuid, value.authorGuid, value.body);
    }
  }
}
