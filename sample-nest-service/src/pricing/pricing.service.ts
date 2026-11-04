import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Column, Entity, In, PrimaryColumn, Repository } from 'typeorm';
import type { Tier } from '../customers/customers.service.ts';
import type { OrderLine } from '../orders/order.entity.ts';
import { PromotionsService } from './promotions.service.ts';

@Entity('products')
export class Product {
  @PrimaryColumn()
  id: string;

  @Column('numeric')
  price: number;

  @Column('numeric')
  weightKg: number;
}

/** Loyalty discount on what is left after promotions. */
const LOYALTY: Record<Tier, number> = { standard: 0, gold: 0.05, platinum: 0.1 };

export interface Quote {
  subtotal: number;
  discount: number;
  loyaltyDiscount: number;
  tax: number;
  total: number;
  promotionIds: string[];
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

/** Pricing: product prices, running promotions and tax for a basket. */
@Injectable()
export class PricingService {
  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
    private readonly promotions: PromotionsService,
    private readonly tax: TaxClient,
  ) {}

  async quote(lines: OrderLine[], country: string, tier: Tier): Promise<Quote> {
    const ids = lines.map((l) => l.productId);
    const products = await this.products.findBy({ id: In(ids) });
    const promos = await this.promotions.activeFor(ids);
    let subtotal = 0;
    let discount = 0;
    for (const line of lines) {
      const price = (products.find((p) => p.id === line.productId)?.price ?? 0) * line.quantity;
      const promo = promos.find((p) => p.productId === line.productId);
      subtotal += price;
      if (promo) discount += (price * promo.percentOff) / 100;
    }
    const loyaltyDiscount = (subtotal - discount) * LOYALTY[tier];
    const rate = await this.tax.rateFor(country);
    const taxable = subtotal - discount - loyaltyDiscount;
    return {
      subtotal, discount: round(discount), loyaltyDiscount: round(loyaltyDiscount), tax: round(taxable * rate), total: round(taxable * (1 + rate)),
      promotionIds: promos.map((p) => p.id),
    };
  }

  /** Records that an order used the quote's promotions. */
  async redeem(orderId: string, customerId: string, quote: Quote): Promise<void> {
    if (quote.promotionIds.length) await this.promotions.redeem(orderId, customerId, quote.promotionIds);
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
