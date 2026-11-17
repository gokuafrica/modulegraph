import { Type } from '@nestjs/common';
import { BaseConsumerHandler } from '@acme/nestjs-kafkajs';
import { UserRecordDataUpdatedHandler } from './handlers/user-record-data-updated.handler';
import { UserRecordCreatedHandler } from './handlers/user-record-created.handler';
import { CommentAddedHandler } from './handlers/comment-added.handler';
import { ReviewEscalatedHandler } from './handlers/review-escalated.handler';

export const ConsumerHandlerMap = new Map<string, Type<BaseConsumerHandler<any, any>>>([
  ['user-record-data-updated', UserRecordDataUpdatedHandler],
  ['user-record-created', UserRecordCreatedHandler],
  ['comment-added', CommentAddedHandler],
  ['review-escalated', ReviewEscalatedHandler],
]);
