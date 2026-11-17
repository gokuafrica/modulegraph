import { Module } from '@nestjs/common';
import { UserRecordsModule } from '../user-records/user-records.module';
import { DuplicateRecordsService } from './services/duplicate-records.service';

@Module({ imports: [UserRecordsModule], providers: [DuplicateRecordsService], exports: [DuplicateRecordsService] })
export class DuplicatesModule {}
