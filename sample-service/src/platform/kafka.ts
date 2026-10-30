export type Message = Record<string, unknown>;
type Handler = (message: Message) => Promise<void>;

const subscribers = new Map<string, Handler[]>();

export class KafkaProducer {
  async produce(topic: string, message: Message): Promise<void> {
    for (const handler of subscribers.get(topic) ?? []) await handler(message);
  }
}

export class KafkaConsumer {
  constructor(readonly groupId: string) {}

  subscribe(topic: string, handler: Handler): void {
    subscribers.set(topic, [...(subscribers.get(topic) ?? []), handler]);
  }
}
