import { Injectable } from '@nestjs/common';
import { AuditLogService } from '../../audit-log/services/audit-log.service';
import { EscalationsService } from '../../escalations/services/escalations.service';
import { SyncFeatureBaseHandler } from '../base/sync-feature-base.handler';
import { ConsumersManagerService } from '../services/consumers-manager.service';
import { SyncFeatureMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class SyncEscalationsFeatureHandler extends SyncFeatureBaseHandler<SyncFeatureMessage> {
  protected readonly feature = 'escalations';

  constructor(
    consumersManager: ConsumersManagerService,
    auditLogService: AuditLogService,
    private readonly escalationsService: EscalationsService,
  ) {
    super(consumersManager, auditLogService);
  }

  protected async syncFeature(message: SyncFeatureMessage): Promise<void> {
    for (const reason of message.values) {
      await this.escalationsService.open(message.recordGuid, reason, 'feature-sync');
    }
  }
}
