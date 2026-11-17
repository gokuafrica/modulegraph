import { Module } from '@nestjs/common';
import { ManualReviewController } from './controllers/manual-review.controller';
import { ManualReviewService } from './services/manual-review.service';
import { UserRecordsModule } from '../user-records/user-records.module';

@Module({
  imports: [UserRecordsModule],
  controllers: [ManualReviewController],
  providers: [ManualReviewService],
  exports: [ManualReviewService],
})
export class ManualReviewModule {}
