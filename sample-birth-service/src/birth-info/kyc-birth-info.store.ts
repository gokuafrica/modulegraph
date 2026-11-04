import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Column, Entity, PrimaryColumn, Repository } from 'typeorm';
import type { KycBirthInfoDto } from './birth-info.types.ts';

/** Birth info the user provided during KYC. One row per user; a new submission overwrites it. */
@Entity('kyc_birth_info')
export class KycBirthInfo {
  @PrimaryColumn()
  userId: string;

  @Column()
  countryOfBirth: string;

  @Column()
  placeOfBirth: string;

  @Column()
  updatedAt: string;
}

/** Owns the kyc_birth_info table. */
@Injectable()
export class KycBirthInfoStore {
  constructor(@InjectRepository(KycBirthInfo) private readonly rows: Repository<KycBirthInfo>) {}

  async find(userId: string): Promise<KycBirthInfo | null> {
    return this.rows.findOneBy({ userId });
  }

  /** Overwrites whatever the user submitted before. */
  async save(userId: string, info: KycBirthInfoDto): Promise<KycBirthInfo> {
    return this.rows.save({ userId, countryOfBirth: info.countryOfBirth, placeOfBirth: info.placeOfBirth, updatedAt: new Date().toISOString() });
  }
}
