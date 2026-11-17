import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { AcmeLogger } from '@acme/nestjs-logging';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { TagsService } from '../../../tags/services/tags.service';
import { RecordTag } from '../../../tags/entity/record-tag.entity';

const OBSOLETE_TAGS = ['legacy-import', 'migrated-2019'];

@Injectable()
export class TagCleanupService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(RecordTag, 'admin') private readonly tagRepository: Repository<RecordTag>,
    private readonly tagsService: TagsService,
    private readonly logger: AcmeLogger,
  ) {}

  async onApplicationBootstrap() {
    const obsolete = await this.tagRepository.find({ where: { tag: In(OBSOLETE_TAGS) } });
    for (const tag of obsolete) {
      await this.tagsService.removeTag(tag.recordGuid, tag.tag);
    }
    this.logger.info('tag cleanup finished', { removed: obsolete.length });
  }
}
