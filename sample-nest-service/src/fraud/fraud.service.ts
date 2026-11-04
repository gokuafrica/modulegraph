import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Repository } from 'typeorm';
import type { Tier } from '../customers/customers.service.ts';
import { needsReview } from './policy.ts';

@Entity('fraud_checks')
export class FraudCheck {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  customerId: string;

  @Column('numeric')
  score: number;

  @Column()
  hold: boolean;

  @CreateDateColumn()
  at: Date;
}

export interface RiskInput {
  customerId: string;
  country: string;
  total: number;
  tier: Tier;
}

export interface Assessment {
  score: number;
  hold: boolean;
}

/** Fraud: scores an order with the risk provider and keeps every score for the fraud desk. */
@Injectable()
export class FraudService {
  constructor(
    private readonly http: HttpService,
    @InjectRepository(FraudCheck) private readonly checks: Repository<FraudCheck>,
  ) {}

  async assess(input: RiskInput): Promise<Assessment> {
    const res = await firstValueFrom(this.http.post<{ score: number }>('https://risk.example.com/v1/score', {
      customerId: input.customerId, country: input.country, amount: input.total,
    }));
    const hold = needsReview(res.data.score, input.total, input.tier);
    await this.checks.insert({ customerId: input.customerId, score: res.data.score, hold });
    return { score: res.data.score, hold };
  }
}
