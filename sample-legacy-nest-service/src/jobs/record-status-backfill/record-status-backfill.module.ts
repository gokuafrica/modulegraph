import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AcmeLoggerModule } from '@acme/nestjs-logging';
import { configuration } from '../../config/configuration';
import { DatabaseModule } from '../../config/database.module';
import { UserRecord } from '../../user-records/entity/user-record.entity';
import { UserRecordStatus } from '../../user-records/entity/user-record-status.entity';
import { RecordStatusBackfillService } from './services/record-status-backfill.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    AcmeLoggerModule.forRoot({ service: 'user-records-service/record-status-backfill' }),
    DatabaseModule,
    TypeOrmModule.forFeature([UserRecord, UserRecordStatus], 'legacy'),
  ],
  providers: [RecordStatusBackfillService],
})
export class RecordStatusBackfillModule {}
