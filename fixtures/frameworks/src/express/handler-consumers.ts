import type { Kafka } from 'kafkajs';

/** Something that handles the messages of one consumer group; which topic it reads is decided at run time. */
export interface MessageHandler {
  groupId: string;
  topic: string;
  handle(value: string): Promise<void>;
}

/**
 * One consumer per registered handler, started in a loop: neither the topic nor the handler is known before run
 * time, so none of these is an entry point the analysis can name (a coverage sign instead, not a `topic ?` entry).
 */
export async function startHandlerConsumers(kafka: Kafka, handlers: MessageHandler[]): Promise<void> {
  for (const handler of handlers) {
    const consumer = kafka.consumer({ groupId: handler.groupId });
    await consumer.connect();
    await consumer.subscribe({ topic: handler.topic });
    await consumer.run({
      eachMessage: async ({ message }) => {
        await handler.handle(String(message.value));
      },
    });
  }
}
