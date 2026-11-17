import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AcmeLoggerModule } from '@acme/nestjs-logging';
import { configuration } from '../../config/configuration';
import { DatabaseModule } from '../../config/database.module';
import { MessagingModule } from '../../config/messaging.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogModule } from '../../audit-log/audit-log.module';
import { KmsModule } from '../../kms/kms.module';
import { UserRecord } from '../../user-records/entity/user-record.entity';
import { ManualDataReencryptService } from './services/manual-data-reencrypt.service';

@Module({})
export class ManualDataReencryptModule {
  static register(): DynamicModule {
    return {
      module: ManualDataReencryptModule,
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        AcmeLoggerModule.forRoot({ service: 'user-records-service/manual-data-reencrypt' }),
        DatabaseModule,
        MessagingModule,
        KmsModule,
        AuditLogModule,
        TypeOrmModule.forFeature([UserRecord], 'legacy'),
      ],
      providers: [ManualDataReencryptService],
    };
  }
}
