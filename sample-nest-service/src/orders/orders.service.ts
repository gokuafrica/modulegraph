import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClientKafka } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { InventoryService } from '../inventory/inventory.service.ts';
import { PaymentsService } from '../payments/payments.service.ts';
import { PricingService } from '../pricing/pricing.service.ts';
import { type CreateOrderDto, Order } from './order.entity.ts';

/** Orders: places, cancels and tracks orders. Owns the orders table and the orders.* topics. */
@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly pricing: PricingService,
    private readonly inventory: InventoryService,
    private readonly payments: PaymentsService,
    private readonly events: EventEmitter2,
    @Inject('ORDER_EVENTS') private readonly kafka: ClientKafka,
  ) {}

  async create(dto: CreateOrderDto): Promise<Order> {
    const quote = await this.pricing.quote(dto.lines, dto.country);
    await this.inventory.reserve(dto.lines);
    const order = await this.orders.save({ ...dto, status: 'pending', total: quote.total });
    this.kafka.emit('orders.created', { orderId: order.id, total: order.total });
    this.events.emit('order.created', order);
    return order;
  }

  async get(id: string): Promise<Order> {
    const order = await this.orders.findOneBy({ id });
    if (!order) throw new NotFoundException(`order ${id}`);
    return order;
  }

  async list(customerId: string): Promise<Order[]> {
    return this.orders.findBy({ customerId });
  }

  async cancel(id: string): Promise<Order> {
    const order = await this.get(id);
    if (order.status === 'paid') await this.payments.refund(order);
    await this.inventory.release(order.lines);
    await this.orders.update({ id }, { status: 'cancelled' });
    this.kafka.emit('orders.cancelled', { orderId: id });
    return { ...order, status: 'cancelled' };
  }

  async markPaid(orderId: string, paymentId: string): Promise<void> {
    await this.orders.update({ id: orderId }, { status: 'paid' });
    this.events.emit('order.paid', { orderId, paymentId });
  }

  async markShipped(orderId: string): Promise<void> {
    await this.orders.update({ id: orderId }, { status: 'shipped' });
  }

  /** Pending orders older than `minutes` give their stock back. */
  async expirePending(minutes: number): Promise<number> {
    const stale = await this.orders.findBy({ status: 'pending', createdAt: LessThan(new Date(Date.now() - minutes * 60_000)) });
    for (const order of stale) {
      await this.inventory.release(order.lines);
      await this.orders.update({ id: order.id }, { status: 'expired' });
    }
    return stale.length;
  }
}
