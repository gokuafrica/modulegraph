import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Column, Entity, PrimaryColumn, Repository } from 'typeorm';
import type { OrderLine } from '../orders/order.entity.ts';

@Entity('stock_items')
export class StockItem {
  @PrimaryColumn()
  productId: string;

  @Column()
  available: number;

  @Column()
  reserved: number;
}

@Injectable()
export class InventoryService {
  constructor(@InjectRepository(StockItem) private readonly stock: Repository<StockItem>) {}

  async reserve(lines: OrderLine[]): Promise<void> {
    for (const line of lines) {
      const item = await this.stock.findOneBy({ productId: line.productId });
      if (!item || item.available < line.quantity) throw new ConflictException(`out of stock: ${line.productId}`);
      await this.stock.update({ productId: line.productId }, { available: item.available - line.quantity, reserved: item.reserved + line.quantity });
    }
  }

  async release(lines: OrderLine[]): Promise<void> {
    for (const line of lines) {
      await this.stock.increment({ productId: line.productId }, 'available', line.quantity);
      await this.stock.decrement({ productId: line.productId }, 'reserved', line.quantity);
    }
  }
}
