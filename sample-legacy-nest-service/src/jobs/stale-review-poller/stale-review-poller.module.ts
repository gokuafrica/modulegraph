import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AcmeLoggerModule } from '@acme/nestjs-logging';
import { configuration } from '../../config/configuration';
import { DatabaseModule } from '../../config/database.module';
import { MessagingModule } from '../../config/messaging.module';
import { DateModule } from '../../date/date.module';
import { RequestContextModule } from '../../request-context/request-context.module';
import { AssignmentsModule } from '../../assignments/assignments.module';
import { EscalationsModule } from '../../escalations/escalations.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { StaleReviewPollerService } from './services/stale-review-poller.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    AcmeLoggerModule.forRoot({ service: 'user-records-service/stale-review-poller' }),
    DatabaseModule,
    MessagingModule,
    DateModule,
    RequestContextModule,
    AssignmentsModule,
    EscalationsModule,
    NotificationsModule,
  ],
  providers: [StaleReviewPollerService],
})
export class StaleReviewPollerModule {}
