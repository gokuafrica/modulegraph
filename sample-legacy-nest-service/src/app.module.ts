import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AcmeLoggerModule } from '@acme/nestjs-logging';
import { configuration } from './config/configuration';
import { DatabaseModule } from './config/database.module';
import { MessagingModule } from './config/messaging.module';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { RequestContextModule } from './request-context/request-context.module';
import { MetricsModule } from './metrics/metrics.module';
import { HealthModule } from './health/health.module';
import { KmsModule } from './kms/kms.module';
import { DateModule } from './date/date.module';
import { OutboxModule } from './outbox/outbox.module';
import { UserRecordsModule } from './user-records/user-records.module';
import { ManualReviewModule } from './manual-review/manual-review.module';
import { CommentsModule } from './comments/comments.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AssignmentsModule } from './assignments/assignments.module';
import { EscalationsModule } from './escalations/escalations.module';
import { ReportsModule } from './reports/reports.module';
import { TagsModule } from './tags/tags.module';
import { DocumentsModule } from './documents/documents.module';
import { ConsumersModule } from './consumers/consumers.module';
import { DuplicatesModule } from './duplicates/duplicates.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    AcmeLoggerModule.forRoot({ service: 'user-records-service' }),
    DatabaseModule,
    MessagingModule,
    RequestContextModule,
    MetricsModule,
    HealthModule,
    KmsModule,
    DateModule,
    OutboxModule,
    UserRecordsModule,
    ManualReviewModule,
    CommentsModule,
    AuditLogModule,
    NotificationsModule,
    AssignmentsModule,
    EscalationsModule,
    ReportsModule,
    TagsModule,
    DocumentsModule,
    DuplicatesModule,
    ConsumersModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
