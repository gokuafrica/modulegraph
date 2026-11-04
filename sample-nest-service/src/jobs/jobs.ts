import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { OrdersService } from '../orders/orders.service.ts';
import { PaymentsService } from '../payments/payments.service.ts';

@Injectable()
export class ScheduledJobs {
  private readonly log = new Logger(ScheduledJobs.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly orders: OrdersService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'payments-reconciliation' })
  async reconcilePayments(): Promise<void> {
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const { missing } = await this.payments.reconcile(day);
    if (missing.length) this.log.warn(`unreconciled payments: ${missing.join(', ')}`);
  }

  @Interval(60_000)
  async expireStaleOrders(): Promise<void> {
    await this.orders.expirePending(30);
  }
}
