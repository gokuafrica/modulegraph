import { Module } from '@nestjs/common';
import { ManualReviewController } from './controllers/manual-review.controller';
import { ManualReviewService } from './services/manual-review.service';
import { ConcludeManualReviewDecisionService } from './services/conclude-manual-review-decision-service';
import { UserRecordsModule } from '../user-records/user-records.module';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [UserRecordsModule, OutboxModule],
  controllers: [ManualReviewController],
  providers: [ManualReviewService, ConcludeManualReviewDecisionService],
  exports: [ManualReviewService],
})
export class ManualReviewModule {}
