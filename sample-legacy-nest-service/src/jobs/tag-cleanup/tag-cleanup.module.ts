import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AcmeLoggerModule } from '@acme/nestjs-logging';
import { configuration } from '../../config/configuration';
import { DatabaseModule } from '../../config/database.module';
import { MessagingModule } from '../../config/messaging.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TagsModule } from '../../tags/tags.module';
import { RecordTag } from '../../tags/entity/record-tag.entity';
import { TagCleanupService } from './services/tag-cleanup.service';

@Module({})
export class TagCleanupModule {
  static register(): DynamicModule {
    return {
      module: TagCleanupModule,
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        AcmeLoggerModule.forRoot({ service: 'user-records-service/tag-cleanup' }),
        DatabaseModule,
        MessagingModule,
        TagsModule,
        TypeOrmModule.forFeature([RecordTag], 'admin'),
      ],
      providers: [TagCleanupService],
    };
  }
}
