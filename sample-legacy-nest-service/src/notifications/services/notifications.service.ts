import { Injectable } from '@nestjs/common';
import { AvroProducer, KafkaJsService } from '@acme/nestjs-kafkajs';
import { AcmeLogger } from '@acme/nestjs-logging';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly avroProducer: AvroProducer,
    private readonly kafkaJsService: KafkaJsService,
    private readonly logger: AcmeLogger,
  ) {}

  async notifyAgentAssigned(agentGuid: string, recordGuid: string): Promise<void> {
    await this.avroProducer.send('review-tools.agent-assigned.v1', { agentGuid, recordGuid });
  }

  async notifyEscalation(recordGuid: string, reason: string, escalatedBy: string): Promise<void> {
    this.logger.info('escalating record', { recordGuid, reason });
    await this.avroProducer.send('review-tools.record-escalated.v1', { recordGuid, reason, escalatedBy }, recordGuid);
  }

  async notifyStaleReviews(recordGuids: string[]): Promise<void> {
    await this.kafkaJsService.sendMessage('review-tools.stale-reviews.v1', recordGuids.map((guid) => ({ key: guid, value: JSON.stringify({ guid }) })));
  }
}
