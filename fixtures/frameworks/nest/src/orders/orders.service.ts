import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Order } from './order.entity.ts';

/** Orders: reads, cancels, holds and expires orders. */
@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly manager: EntityManager,
  ) {}

  async get(id: string): Promise<Order> {
    const order = await this.orders.findOneBy({ id });
    if (!order) throw new NotFoundException();
    return order;
  }

  async cancel(id: string): Promise<void> {
    await this.orders.update({ id }, { status: 'cancelled' });
  }

  async release(id: string): Promise<void> {
    await this.dataSource.query('DELETE FROM order_holds WHERE order_id = $1', [id]);
  }

  /** A fraud reviewer's decision on a held order. */
  async resolveHold(id: string, approve: boolean): Promise<void> {
    if (approve) await this.release(id);
    else await this.cancel(id);
  }

  /** Expires orders pending for more than a day; returns how many are left. */
  async expireStale(): Promise<number> {
    await this.orders
      .createQueryBuilder('o')
      .update()
      .set({ status: 'expired' })
      .where('created_at < now() - interval \'1 day\'')
      .execute();
    const rows: { n: number }[] = await this.manager.query(`SELECT count(*) AS n FROM orders WHERE status = 'pending'`);
    return rows[0].n;
  }
}
