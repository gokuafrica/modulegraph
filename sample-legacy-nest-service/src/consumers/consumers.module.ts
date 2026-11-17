import { Module } from '@nestjs/common';
import { ConsumersManagerService } from './services/consumers-manager.service';
import { ConsumerHandlerMap } from './consumer-handler.map';
import { ManualReviewModule } from '../manual-review/manual-review.module';
import { UserRecordsModule } from '../user-records/user-records.module';
import { CommentsModule } from '../comments/comments.module';
import { EscalationsModule } from '../escalations/escalations.module';
import { TagsModule } from '../tags/tags.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { DocumentsModule } from '../documents/documents.module';
import { DuplicatesModule } from '../duplicates/duplicates.module';
import { MetricsModule } from '../metrics/metrics.module';

@Module({
  imports: [ManualReviewModule, UserRecordsModule, CommentsModule, EscalationsModule, TagsModule, AssignmentsModule, AuditLogModule, DocumentsModule, DuplicatesModule, MetricsModule],
  providers: [ConsumersManagerService, ...ConsumerHandlerMap.values()],
  exports: [ConsumersManagerService],
})
export class ConsumersModule {}
