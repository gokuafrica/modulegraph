import { Injectable } from '@nestjs/common';
import { AuditLogService } from '../../audit-log/services/audit-log.service';
import { AssignmentsService } from '../../assignments/services/assignments.service';
import { SyncFeatureBaseHandler } from '../base/sync-feature-base.handler';
import { ConsumersManagerService } from '../services/consumers-manager.service';
import { SyncFeatureMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class SyncAssignmentsFeatureHandler extends SyncFeatureBaseHandler<SyncFeatureMessage> {
  protected readonly feature = 'assignments';

  constructor(
    consumersManager: ConsumersManagerService,
    auditLogService: AuditLogService,
    private readonly assignmentsService: AssignmentsService,
  ) {
    super(consumersManager, auditLogService);
  }

  protected async syncFeature(message: SyncFeatureMessage): Promise<void> {
    if (message.values.length) {
      await this.assignmentsService.assign(message.recordGuid, message.values[message.values.length - 1]);
    }
  }
}
