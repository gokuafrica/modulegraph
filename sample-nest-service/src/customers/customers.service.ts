import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Column, Entity, PrimaryColumn, Repository } from 'typeorm';

export type Tier = 'standard' | 'gold' | 'platinum';

@Entity('customers')
export class Customer {
  @PrimaryColumn()
  id: string;

  @Column()
  name: string;

  @Column()
  email: string;

  @Column({ type: 'varchar' })
  tier: Tier;

  @Column()
  blocked: boolean;
}

export interface CustomerProfile {
  id: string;
  name: string;
  email: string;
  tier: Tier;
}

/** Customers: who is ordering, their loyalty tier, and whether they may order at all. */
@Injectable()
export class CustomersService {
  constructor(@InjectRepository(Customer) private readonly customers: Repository<Customer>) {}

  async profile(id: string): Promise<CustomerProfile> {
    const customer = await this.customers.findOneBy({ id });
    if (!customer) throw new NotFoundException(`customer ${id}`);
    if (customer.blocked) throw new ForbiddenException(`customer ${id} is blocked`);
    return { id: customer.id, name: customer.name, email: customer.email, tier: customer.tier };
  }
}
