import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TagsController } from './controllers/tags.controller';
import { RecordTag } from './entity/record-tag.entity';
import { TagsService } from './services/tags.service';

@Module({ imports: [TypeOrmModule.forFeature([RecordTag], 'admin')], controllers: [TagsController], providers: [TagsService] })
export class TagsModule {}
