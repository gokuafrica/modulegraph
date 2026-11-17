import { Injectable } from '@nestjs/common';
import { AuditLogService } from '../../audit-log/services/audit-log.service';
import { DocumentsService } from '../../documents/services/documents.service';
import { SyncFeatureBaseHandler } from '../base/sync-feature-base.handler';
import { ConsumersManagerService } from '../services/consumers-manager.service';
import { SyncFeatureMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class SyncDocumentsFeatureHandler extends SyncFeatureBaseHandler<SyncFeatureMessage> {
  protected readonly feature = 'documents';

  constructor(
    consumersManager: ConsumersManagerService,
    auditLogService: AuditLogService,
    private readonly documentsService: DocumentsService,
  ) {
    super(consumersManager, auditLogService);
  }

  protected async syncFeature(message: SyncFeatureMessage): Promise<void> {
    await this.documentsService.listForRecord(message.recordGuid);
  }
}
