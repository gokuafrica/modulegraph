import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Column, Entity, In, MoreThan, PrimaryColumn, PrimaryGeneratedColumn, Repository } from 'typeorm';

@Entity('promotions')
export class Promotion {
  @PrimaryColumn()
  id: string;

  @Column()
  productId: string;

  @Column('numeric')
  percentOff: number;

  @Column()
  endsAt: Date;
}

@Entity('promotion_redemptions')
export class PromotionRedemption {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  promotionId: string;

  @Column()
  orderId: string;

  @Column()
  customerId: string;
}

/** Promotions: running product discounts, and who used them (marketing reports on redemptions). */
@Injectable()
export class PromotionsService {
  constructor(
    @InjectRepository(Promotion) private readonly promotions: Repository<Promotion>,
    @InjectRepository(PromotionRedemption) private readonly redemptions: Repository<PromotionRedemption>,
  ) {}

  async activeFor(productIds: string[]): Promise<Promotion[]> {
    return this.promotions.findBy({ productId: In(productIds), endsAt: MoreThan(new Date()) });
  }

  async redeem(orderId: string, customerId: string, promotionIds: string[]): Promise<void> {
    await this.redemptions.insert(promotionIds.map((promotionId) => ({ promotionId, orderId, customerId })));
  }
}
