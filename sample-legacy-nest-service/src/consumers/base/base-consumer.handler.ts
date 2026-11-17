import { AvroKafkaMessage } from '@acme/nestjs-kafkajs';
import type { ConsumersManagerService } from '../services/consumers-manager.service';

/**
 * Every Kafka consumer handler extends this. Nest creates one instance per handler, and the instance registers itself
 * with the consumers manager, which starts the consumers selected on the command line.
 */
export abstract class BaseConsumerHandler<T, R = void> {
  protected constructor(protected readonly consumersManager: ConsumersManagerService) {
    consumersManager.addHandler(this);
  }

  abstract handleMessages(messages: AvroKafkaMessage<T>[]): Promise<void>;

  protected header(message: AvroKafkaMessage<T>, name: string): string | undefined {
    return message.headers[name];
  }

  protected lastResult?: R;
}
