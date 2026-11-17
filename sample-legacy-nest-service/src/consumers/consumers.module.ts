import { Module } from '@nestjs/common';
import { ConsumersManagerService } from './services/consumers-manager.service';
import { UserRecordDataUpdatedHandler } from './handlers/user-record-data-updated.handler';
import { UserRecordCreatedHandler } from './handlers/user-record-created.handler';
import { CommentAddedHandler } from './handlers/comment-added.handler';
import { ReviewEscalatedHandler } from './handlers/review-escalated.handler';
import { ManualReviewModule } from '../manual-review/manual-review.module';
import { UserRecordsModule } from '../user-records/user-records.module';
import { CommentsModule } from '../comments/comments.module';
import { EscalationsModule } from '../escalations/escalations.module';

@Module({
  imports: [ManualReviewModule, UserRecordsModule, CommentsModule, EscalationsModule],
  providers: [ConsumersManagerService, UserRecordDataUpdatedHandler, UserRecordCreatedHandler, CommentAddedHandler, ReviewEscalatedHandler],
})
export class ConsumersModule {}
