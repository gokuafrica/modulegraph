import { Injectable } from '@nestjs/common';
import { OutboxMessage } from '@acme/typeorm-outbox-writer';
import { DateService } from '../../date/services/date.service';
import { RequestContextService } from '../../request-context/services/request-context.service';

export type SyncedMessageType = 'UserRecordApprovedNotification' | 'UserRecordRejectedNotification' | 'UserRecordDataCorrectedNotification';

/** Builds the outbox messages that keep review-tools in sync with a record's review state. */
@Injectable()
export class SyncedMessageService {
  constructor(
    private readonly dateService: DateService,
    private readonly requestContextService: RequestContextService,
  ) {}

  async createSyncedMessage(guid: string, recordId: number, type: SyncedMessageType): Promise<OutboxMessage> {
    return {
      type,
      aggregateId: guid,
      payload: { guid, recordId, correlationId: this.requestContextService.getCorrelationId() },
      occurredAt: this.dateService.now(),
    };
  }
}
