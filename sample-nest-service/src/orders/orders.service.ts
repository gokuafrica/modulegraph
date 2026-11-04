import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClientKafka } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service.ts';
import { CustomersService } from '../customers/customers.service.ts';
import { InventoryService } from '../inventory/inventory.service.ts';
import { PaymentsService } from '../payments/payments.service.ts';
import { PricingService } from '../pricing/pricing.service.ts';
import { ShippingService } from '../shipping/shipping.service.ts';
import { type CreateOrderDto, type OrderDetails, type OrderLine, Order, OrderLineRow, type OrderView, type QuotePreview } from './order.entity.ts';

/** Orders: places, cancels and tracks orders. Owns the orders and order_lines tables and the orders.* topics. */
@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(OrderLineRow) private readonly lines: Repository<OrderLineRow>,
    private readonly customers: CustomersService,
    private readonly pricing: PricingService,
    private readonly shipping: ShippingService,
    private readonly inventory: InventoryService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
    @Inject('ORDER_EVENTS') private readonly kafka: ClientKafka,
  ) {}

  /** Price a basket without placing it (the checkout page calls this on every change). */
  async preview(dto: CreateOrderDto): Promise<QuotePreview> {
    await this.customers.profile(dto.customerId);
    const quote = await this.pricing.quote(dto.lines, dto.country);
    const shippingCost = await this.shipping.rates(dto.country, dto.lines);
    return { ...quote, shippingCost, grandTotal: quote.total + shippingCost };
  }

  async create(dto: CreateOrderDto): Promise<Order> {
    const customer = await this.customers.profile(dto.customerId);
    const quote = await this.pricing.quote(dto.lines, dto.country);
    const shippingCost = await this.shipping.rates(dto.country, dto.lines);
    await this.inventory.reserve(dto.lines);
    const order = await this.orders.save({
      customerId: customer.id, country: dto.country, status: 'pending', shippingCost, total: quote.total + shippingCost,
    });
    await this.lines.insert(dto.lines.map((l) => ({ ...l, orderId: order.id })));
    await this.pricing.redeem(order.id, customer.id, quote);
    this.kafka.emit('orders.created', { orderId: order.id, total: order.total });
    this.events.emit('order.created', { ...order, email: customer.email });
    return order;
  }

  async get(id: string): Promise<OrderView> {
    const order = await this.load(id);
    const customer = await this.customers.profile(order.customerId);
    const tracking = order.status === 'shipped' ? await this.shipping.tracking(id) : undefined;
    return { ...order, customer: { name: customer.name, tier: customer.tier }, tracking };
  }

  async list(customerId: string): Promise<Order[]> {
    return this.orders.findBy({ customerId });
  }

  async cancel(id: string): Promise<Order> {
    const order = await this.load(id);
    if (order.status === 'paid') await this.payments.refund(order);
    await this.inventory.release(order.lines);
    await this.orders.update({ id }, { status: 'cancelled' });
    await this.audit.record('order.cancelled', id, { previous: order.status });
    this.kafka.emit('orders.cancelled', { orderId: id });
    return { ...order, status: 'cancelled' };
  }

  async markPaid(orderId: string, paymentId: string): Promise<void> {
    await this.orders.update({ id: orderId }, { status: 'paid' });
    await this.audit.record('order.paid', orderId, { paymentId });
    this.events.emit('order.paid', { orderId, paymentId });
  }

  async markShipped(orderId: string, carrier: string, trackingNo: string): Promise<void> {
    await this.orders.update({ id: orderId }, { status: 'shipped' });
    await this.shipping.recordDispatch(orderId, carrier, trackingNo);
  }

  /** Pending orders older than `minutes` give their stock back. */
  async expirePending(minutes: number): Promise<number> {
    const stale = await this.orders.findBy({ status: 'pending', createdAt: LessThan(new Date(Date.now() - minutes * 60_000)) });
    for (const order of stale) {
      await this.inventory.release(await this.linesOf(order.id));
      await this.orders.update({ id: order.id }, { status: 'expired' });
    }
    return stale.length;
  }

  private async load(id: string): Promise<OrderDetails> {
    const order = await this.orders.findOneBy({ id });
    if (!order) throw new NotFoundException(`order ${id}`);
    return { ...order, lines: await this.linesOf(id) };
  }

  private async linesOf(orderId: string): Promise<OrderLine[]> {
    const rows = await this.lines.findBy({ orderId });
    return rows.map((r) => ({ productId: r.productId, quantity: r.quantity }));
  }
}
