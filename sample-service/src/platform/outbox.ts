import { Db, type Row } from './db.ts';

/** Transactional outbox: events are written next to business data and relayed to Kafka later. */
export class Outbox {
  constructor(private readonly db: Db) {}

  async enqueue(eventType: string, payload: Row): Promise<void> {
    await this.db.insert('outbox', { eventType, payload, createdAt: new Date().toISOString() });
  }
}
