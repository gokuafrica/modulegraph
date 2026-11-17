import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserRecordsController } from './controllers/user-records.controller';
import { UserRecord } from './entity/user-record.entity';
import { UserRecordStatus } from './entity/user-record-status.entity';
import { UserRecordService } from './services/user-record.service';
import { UserRecordStatusService } from './services/user-record-status.service';
import { UserRecordDataTransformer } from './services/user-record-data.transformer';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [TypeOrmModule.forFeature([UserRecord, UserRecordStatus], 'legacy'), OutboxModule],
  controllers: [UserRecordsController],
  providers: [UserRecordService, UserRecordStatusService, UserRecordDataTransformer],
  exports: [UserRecordService, UserRecordStatusService, UserRecordDataTransformer],
})
export class UserRecordsModule {}
