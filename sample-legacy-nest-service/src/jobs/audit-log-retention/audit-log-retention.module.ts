import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AcmeLoggerModule } from '@acme/nestjs-logging';
import { configuration } from '../../config/configuration';
import { DatabaseModule } from '../../config/database.module';
import { MessagingModule } from '../../config/messaging.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogEntry } from '../../audit-log/entity/audit-log-entry.entity';
import { AuditLogRetentionService } from './services/audit-log-retention.service';

@Module({})
export class AuditLogRetentionModule {
  static register(): DynamicModule {
    return {
      module: AuditLogRetentionModule,
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        AcmeLoggerModule.forRoot({ service: 'user-records-service/audit-log-retention' }),
        DatabaseModule,
        MessagingModule,
        TypeOrmModule.forFeature([AuditLogEntry], 'admin'),
      ],
      providers: [AuditLogRetentionService],
    };
  }
}
