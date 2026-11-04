import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import type { Tier } from '../customers/customers.service.ts';
import type { Quote } from '../pricing/pricing.service.ts';
import type { Tracking } from '../shipping/shipping.service.ts';

export type OrderStatus = 'pending' | 'paid' | 'cancelled' | 'shipped' | 'expired';

export interface OrderLine {
  productId: string;
  quantity: number;
}

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  customerId: string;

  @Column({ type: 'varchar' })
  status: OrderStatus;

  @Column()
  country: string;

  @Column('numeric')
  shippingCost: number;

  @Column('numeric')
  total: number;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('order_lines')
export class OrderLineRow {
  @PrimaryColumn()
  orderId: string;

  @PrimaryColumn()
  productId: string;

  @Column()
  quantity: number;
}

export interface CreateOrderDto {
  customerId: string;
  country: string;
  lines: OrderLine[];
}

/** An order with its lines. */
export interface OrderDetails extends Order {
  lines: OrderLine[];
}

/** What GET /orders/:id answers: the order, who placed it and where the parcel is. */
export interface OrderView extends OrderDetails {
  customer: { name: string; tier: Tier };
  tracking?: Tracking;
}

/** What GET /orders/quote answers before an order is placed. */
export interface QuotePreview extends Quote {
  shippingCost: number;
  grandTotal: number;
}
