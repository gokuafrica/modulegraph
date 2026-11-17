import { Injectable } from '@nestjs/common';
import { AuditLogService } from '../../audit-log/services/audit-log.service';
import { TagsService } from '../../tags/services/tags.service';
import { SyncFeatureBaseHandler } from '../base/sync-feature-base.handler';
import { ConsumersManagerService } from '../services/consumers-manager.service';
import { SyncFeatureMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class SyncTagsFeatureHandler extends SyncFeatureBaseHandler<SyncFeatureMessage> {
  protected readonly feature = 'tags';

  constructor(
    consumersManager: ConsumersManagerService,
    auditLogService: AuditLogService,
    private readonly tagsService: TagsService,
  ) {
    super(consumersManager, auditLogService);
  }

  protected async syncFeature(message: SyncFeatureMessage): Promise<void> {
    for (const tag of message.values) {
      await this.tagsService.addTag(message.recordGuid, tag);
    }
  }
}
