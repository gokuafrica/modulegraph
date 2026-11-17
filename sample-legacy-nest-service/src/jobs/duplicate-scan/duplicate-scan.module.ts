import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AcmeLoggerModule } from '@acme/nestjs-logging';
import { configuration } from '../../config/configuration';
import { DatabaseModule } from '../../config/database.module';
import { MessagingModule } from '../../config/messaging.module';
import { UserRecordsModule } from '../../user-records/user-records.module';
import { DuplicatesModule } from '../../duplicates/duplicates.module';
import { DuplicateScanService } from './services/duplicate-scan.service';

@Module({})
export class DuplicateScanModule {
  static register(): DynamicModule {
    return {
      module: DuplicateScanModule,
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        AcmeLoggerModule.forRoot({ service: 'user-records-service/duplicate-scan' }),
        DatabaseModule,
        MessagingModule,
        UserRecordsModule,
        DuplicatesModule,
      ],
      providers: [DuplicateScanService],
    };
  }
}
