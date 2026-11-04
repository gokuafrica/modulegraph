import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DocumentBirthInfoService } from '../documents/document-birth-info.service.ts';
import type { BirthInfoView, KycBirthInfoDto } from './birth-info.types.ts';
import { KycBirthInfoStore } from './kyc-birth-info.store.ts';

/** A user's birth info: the document's version and the user's own (KYC) version, side by side. */
@Injectable()
export class BirthInfoService {
  constructor(
    private readonly documents: DocumentBirthInfoService,
    private readonly kyc: KycBirthInfoStore,
    private readonly events: EventEmitter2,
  ) {}

  async get(userId: string): Promise<BirthInfoView> {
    const [document, kyc] = await Promise.all([this.documents.forUser(userId), this.kyc.find(userId)]);
    return {
      userId,
      document,
      kyc: kyc ? { countryOfBirth: kyc.countryOfBirth, placeOfBirth: kyc.placeOfBirth, updatedAt: kyc.updatedAt } : null,
    };
  }

  /** Saves what the user submitted as their KYC birth info, replacing what they submitted before. */
  async updateKycBirthInfo(userId: string, dto: KycBirthInfoDto): Promise<BirthInfoView> {
    await this.kyc.save(userId, { countryOfBirth: dto.countryOfBirth.trim().toUpperCase(), placeOfBirth: dto.placeOfBirth.trim() });
    this.events.emit('kyc.birth_info.updated', { userId });
    return this.get(userId);
  }
}
