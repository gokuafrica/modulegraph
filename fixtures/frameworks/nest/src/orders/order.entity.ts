import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type OrderStatus = 'pending' | 'held' | 'cancelled' | 'released' | 'expired';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() customerId: string;
  @Column() status: OrderStatus;
  @Column() total: number;
  @Column() createdAt: Date;
}

export interface PlaceOrderDto {
  customerId: string;
  total: number;
}
