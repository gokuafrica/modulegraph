import { Injectable } from '@nestjs/common';
import { OutboxWriter } from '@acme/typeorm-outbox-writer';
import { QueryRunner } from 'typeorm';
import { RequestContextService } from '../../request-context/services/request-context.service';

@Injectable()
export class OutboxEventsService {
  constructor(
    private readonly outboxWriter: OutboxWriter,
    private readonly requestContextService: RequestContextService,
  ) {}

  async publish(queryRunner: QueryRunner, eventType: string, payload: Record<string, unknown>): Promise<void> {
    await this.outboxWriter.write(queryRunner, eventType, { ...payload, correlationId: this.requestContextService.getCorrelationId() });
  }
}
