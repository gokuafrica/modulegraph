import { Injectable } from '@nestjs/common';
import { AvroKafkaMessage } from '@acme/nestjs-kafkajs';
import { AssignmentsService } from '../../assignments/services/assignments.service';
import { BaseConsumerHandler } from '../base/base-consumer.handler';
import { ConsumersManagerService } from '../services/consumers-manager.service';
import { AgentAssignedMessage } from '../dto/consumer-messages.dto';

@Injectable()
export class AgentAssignedHandler extends BaseConsumerHandler<AgentAssignedMessage> {
  constructor(
    consumersManager: ConsumersManagerService,
    private readonly assignmentsService: AssignmentsService,
  ) {
    super(consumersManager);
  }

  async handleMessages(messages: AvroKafkaMessage<AgentAssignedMessage>[]): Promise<void> {
    for (const { value } of messages) {
      await this.assignmentsService.assign(value.recordGuid, value.agentGuid);
    }
  }
}
