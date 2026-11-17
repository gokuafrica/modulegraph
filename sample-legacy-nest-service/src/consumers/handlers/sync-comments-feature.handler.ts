import { Injectable } from '@nestjs/common';
import { AuditLogService } from '../../audit-log/services/audit-log.service';
import { CommentsService } from '../../comments/services/comments.service';
import { SyncFeatureBaseHandler } from '../base/sync-feature-base.handler';
import { ConsumersManagerService } from '../services/consumers-manager.service';
import { SyncFeatureMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class SyncCommentsFeatureHandler extends SyncFeatureBaseHandler<SyncFeatureMessage> {
  protected readonly feature = 'comments';

  constructor(
    consumersManager: ConsumersManagerService,
    auditLogService: AuditLogService,
    private readonly commentsService: CommentsService,
  ) {
    super(consumersManager, auditLogService);
  }

  protected async syncFeature(message: SyncFeatureMessage): Promise<void> {
    for (const body of message.values) {
      await this.commentsService.addComment(message.recordGuid, 'feature-sync', body);
    }
  }
}
