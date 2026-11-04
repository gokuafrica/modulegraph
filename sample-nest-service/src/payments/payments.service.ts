import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { firstValueFrom } from 'rxjs';
import { Column, Entity, PrimaryColumn, Repository } from 'typeorm';
import type { Order } from '../orders/order.entity.ts';

@Entity('payments')
export class Payment {
  @PrimaryColumn()
  id: string;

  @Column()
  orderId: string;

  @Column({ type: 'varchar' })
  status: 'authorized' | 'succeeded' | 'failed' | 'refunded';

  @Column('numeric')
  amount: number;
}

export interface ProviderEvent {
  type: 'charge.succeeded' | 'charge.failed';
  paymentId: string;
  orderId: string;
  amount: number;
}

/** Payments: talks to the payment provider and keeps the payments table. */
@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    private readonly http: HttpService,
    @InjectQueue('receipts') private readonly receipts: Queue,
  ) {}

  async forOrder(orderId: string): Promise<Payment[]> {
    return this.payments.findBy({ orderId });
  }

  async handleWebhook(event: ProviderEvent): Promise<Payment> {
    const status = event.type === 'charge.succeeded' ? 'succeeded' : 'failed';
    const payment = await this.payments.save({ id: event.paymentId, orderId: event.orderId, status, amount: event.amount });
    if (status === 'succeeded') await this.receipts.add('send-receipt', { paymentId: payment.id });
    return payment;
  }

  async refund(order: Order): Promise<void> {
    await firstValueFrom(this.http.post('https://api.payments.example/v1/refunds', { orderId: order.id, amount: order.total }));
    await this.payments.update({ orderId: order.id }, { status: 'refunded' });
  }

  /** Compares yesterday's provider settlements with our payments table. */
  async reconcile(day: string): Promise<{ missing: string[] }> {
    const res = await firstValueFrom(this.http.get<{ ids: string[] }>(`https://api.payments.example/v1/settlements?day=${day}`));
    const ours = await this.payments.findBy({ status: 'succeeded' });
    return { missing: res.data.ids.filter((id) => !ours.some((p) => p.id === id)) };
  }
}
