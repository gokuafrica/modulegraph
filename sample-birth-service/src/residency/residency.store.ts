import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Column, Entity, PrimaryGeneratedColumn, Repository } from 'typeorm';
import type { ResidencyDeclarationDto, ResidencyStatus } from './residency.types.ts';

/** One residency declaration. A new declaration adds a row: the history is kept for audits. */
@Entity('residency_declarations')
export class ResidencyDeclaration {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  userId: string;

  @Column()
  countryOfResidence: string;

  @Column()
  city: string;

  @Column()
  postalCode: string;

  @Column()
  addressLine: string;

  @Column()
  status: ResidencyStatus;

  @Column()
  declaredAt: string;
}

/** Owns the residency_declarations table. */
@Injectable()
export class ResidencyStore {
  constructor(@InjectRepository(ResidencyDeclaration) private readonly rows: Repository<ResidencyDeclaration>) {}

  async latest(userId: string): Promise<ResidencyDeclaration | null> {
    return this.rows.findOne({ where: { userId }, order: { declaredAt: 'DESC' } });
  }

  async count(userId: string): Promise<number> {
    return this.rows.countBy({ userId });
  }

  async add(userId: string, address: ResidencyDeclarationDto, status: ResidencyStatus): Promise<void> {
    await this.rows.insert({ userId, ...address, status, declaredAt: new Date().toISOString() });
  }
}
