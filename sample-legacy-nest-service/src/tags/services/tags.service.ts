import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RecordTag } from '../entity/record-tag.entity';

@Injectable()
export class TagsService {
  constructor(@InjectRepository(RecordTag, 'admin') private readonly tagRepository: Repository<RecordTag>) {}

  async addTag(recordGuid: string, tag: string): Promise<void> {
    await this.tagRepository.upsert({ recordGuid, tag }, ['recordGuid', 'tag']);
  }

  async removeTag(recordGuid: string, tag: string): Promise<void> {
    await this.tagRepository.delete({ recordGuid, tag });
  }
}
