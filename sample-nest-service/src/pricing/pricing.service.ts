import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Column, Entity, In, PrimaryColumn, Repository } from 'typeorm';
import type { OrderLine } from '../orders/order.entity.ts';

@Entity('products')
export class Product {
  @PrimaryColumn()
  id: string;

  @Column('numeric')
  price: number;
}

export interface Quote {
  subtotal: number;
  tax: number;
  total: number;
}

/** Tax rates come from the finance team's tax API. */
@Injectable()
export class TaxClient {
  constructor(private readonly http: HttpService) {}

  async rateFor(country: string): Promise<number> {
    const res = await firstValueFrom(this.http.get<{ rate: number }>(`https://tax-api.internal/v1/rates/${country}`));
    return res.data.rate;
  }
}

@Injectable()
export class PricingService {
  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
    private readonly tax: TaxClient,
  ) {}

  async quote(lines: OrderLine[], country: string): Promise<Quote> {
    const products = await this.products.findBy({ id: In(lines.map((l) => l.productId)) });
    const subtotal = lines.reduce((sum, l) => sum + (products.find((p) => p.id === l.productId)?.price ?? 0) * l.quantity, 0);
    const rate = await this.tax.rateFor(country);
    return { subtotal, tax: round(subtotal * rate), total: round(subtotal * (1 + rate)) };
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
