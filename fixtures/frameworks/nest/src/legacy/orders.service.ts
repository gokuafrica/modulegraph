import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** The pre-2024 orders, still in their own table. Same class name as orders/orders.service.ts. */
@Injectable()
export class OrdersService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async get(id: string): Promise<unknown> {
    const rows: unknown[] = await this.db.query('SELECT * FROM legacy_orders WHERE id = $1', [id]);
    return rows[0];
  }

  async cancel(id: string): Promise<void> {
    await this.db.query(`UPDATE legacy_orders SET status = 'cancelled' WHERE id = $1`, [id]);
  }
}
