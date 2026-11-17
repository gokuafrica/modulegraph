import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AcmeLoggerModule } from '@acme/nestjs-logging';
import { configuration } from '../../config/configuration';
import { DatabaseModule } from '../../config/database.module';
import { MessagingModule } from '../../config/messaging.module';
import { AssignmentsModule } from '../../assignments/assignments.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { EscalationDigestService } from './services/escalation-digest.service';

@Module({})
export class EscalationDigestModule {
  static register(): DynamicModule {
    return {
      module: EscalationDigestModule,
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        AcmeLoggerModule.forRoot({ service: 'user-records-service/escalation-digest' }),
        DatabaseModule,
        MessagingModule,
        AssignmentsModule,
        NotificationsModule,
      ],
      providers: [EscalationDigestService],
    };
  }
}
