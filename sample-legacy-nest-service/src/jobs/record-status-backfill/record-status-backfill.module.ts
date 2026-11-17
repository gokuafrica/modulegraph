import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AcmeLoggerModule } from '@acme/nestjs-logging';
import { configuration } from '../../config/configuration';
import { DatabaseModule } from '../../config/database.module';
import { MessagingModule } from '../../config/messaging.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserRecord } from '../../user-records/entity/user-record.entity';
import { UserRecordStatus } from '../../user-records/entity/user-record-status.entity';
import { RecordStatusBackfillService } from './services/record-status-backfill.service';

@Module({})
export class RecordStatusBackfillModule {
  static register(): DynamicModule {
    return {
      module: RecordStatusBackfillModule,
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        AcmeLoggerModule.forRoot({ service: 'user-records-service/record-status-backfill' }),
        DatabaseModule,
        MessagingModule,
        TypeOrmModule.forFeature([UserRecord, UserRecordStatus], 'legacy'),
      ],
      providers: [RecordStatusBackfillService],
    };
  }
}
