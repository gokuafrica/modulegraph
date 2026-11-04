import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

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

  @Column('jsonb')
  lines: OrderLine[];

  @Column()
  country: string;

  @Column('numeric')
  total: number;

  @CreateDateColumn()
  createdAt: Date;
}

export interface CreateOrderDto {
  customerId: string;
  country: string;
  lines: OrderLine[];
}
