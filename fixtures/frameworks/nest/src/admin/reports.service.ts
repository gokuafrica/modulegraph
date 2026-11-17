import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Order } from '../orders/order.entity.ts';

@Injectable()
export class ReportsService {
  constructor(private readonly dataSource: DataSource) {}

  async daily(): Promise<{ day: string; total: number }[]> {
    return this.dataSource
      .createQueryBuilder(Order, 'o')
      .select("date_trunc('day', o.created_at)", 'day')
      .addSelect('sum(o.total)', 'total')
      .groupBy('day')
      .getRawMany();
  }

  async purgeCancelled(): Promise<void> {
    await this.dataSource.createQueryBuilder().delete().from(Order).where("status = 'cancelled'").execute();
  }
}
