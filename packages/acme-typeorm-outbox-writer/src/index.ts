import { Inject, Injectable, Module, type DynamicModule } from '@nestjs/common';
import type { QueryRunner } from 'typeorm';

export const OUTBOX_OPTIONS = 'ACME_OUTBOX_OPTIONS';

export interface OutboxOptions {
  /** Outbox table, in the same database as the caller's transaction. */
  table: string;
  source: string;
}

/**
 * Inserts an event row into the outbox table through the caller's query runner, so the event commits or rolls back
 * with the caller's own writes. A relay (another service) publishes the rows to Kafka.
 */
@Injectable()
export class OutboxWriter {
  constructor(@Inject(OUTBOX_OPTIONS) private readonly options: OutboxOptions) {}

  async write<T extends object>(queryRunner: QueryRunner, eventType: string, payload: T, aggregateId?: string): Promise<void> {
    await queryRunner.query(
      `INSERT INTO ${this.options.table} (event_type, aggregate_id, source, payload, created_at) VALUES (?, ?, ?, ?, NOW())`,
      [eventType, aggregateId ?? null, this.options.source, JSON.stringify(payload)],
    );
  }
}

@Module({})
export class OutboxWriterModule {
  static forRoot(options: OutboxOptions): DynamicModule {
    return {
      module: OutboxWriterModule,
      global: true,
      providers: [{ provide: OUTBOX_OPTIONS, useValue: options }, OutboxWriter],
      exports: [OutboxWriter],
    };
  }
}
