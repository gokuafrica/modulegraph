import { Injectable } from '@nestjs/common';
import { BaseConsumerHandler, KafkaMessage } from '@acme/nestjs-kafkajs';
import { CommentsService } from '../../comments/services/comments.service';
import { CommentAddedMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class CommentAddedHandler extends BaseConsumerHandler<CommentAddedMessage, void> {
  constructor(private readonly commentsService: CommentsService) {
    super();
  }

  async handle(message: KafkaMessage<CommentAddedMessage>): Promise<void> {
    const { recordGuid, authorGuid, body } = message.value;
    await this.commentsService.addComment(recordGuid, authorGuid, body);
  }
}
