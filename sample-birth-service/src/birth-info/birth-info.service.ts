import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { DocumentBirthInfoService } from '../documents/document-birth-info.service.ts';
import { BirthInfoVerifier } from './birth-info-verifier.ts';
import type { BirthInfoView, BirthPlace, KycBirthInfoDto } from './birth-info.types.ts';
import { type KycBirthInfo, KycBirthInfoStore } from './kyc-birth-info.store.ts';

function view(userId: string, document: BirthPlace | null, kyc: KycBirthInfo | null): BirthInfoView {
  return {
    userId,
    document,
    kyc: kyc ? { countryOfBirth: kyc.countryOfBirth, placeOfBirth: kyc.placeOfBirth, updatedAt: kyc.updatedAt } : null,
  };
}

/** A user's birth info: the document's version and the user's own (KYC) version, side by side. */
@Injectable()
export class BirthInfoService {
  constructor(
    private readonly documents: DocumentBirthInfoService,
    private readonly kyc: KycBirthInfoStore,
    private readonly verifier: BirthInfoVerifier,
    private readonly events: EventEmitter2,
    private readonly dataSource: DataSource,
  ) {}

  async get(userId: string): Promise<BirthInfoView> {
    const [document, kyc] = await Promise.all([this.documents.forUser(userId), this.kyc.find(userId)]);
    return view(userId, document, kyc);
  }

  /**
   * Saves what the user submitted as their KYC birth info, replacing what they submitted before.
   * It must agree with their identity document: each part the document has is enforced, a missing part isn't.
   */
  async updateKycBirthInfo(userId: string, dto: KycBirthInfoDto): Promise<BirthInfoView> {
    const submitted = { countryOfBirth: dto.countryOfBirth.trim().toUpperCase(), placeOfBirth: dto.placeOfBirth.trim() };
    const document = await this.documents.forUser(userId);
    const check = this.verifier.verify(submitted, document);
    if (!check.ok) {
      throw new UnprocessableEntityException({ message: 'Birth info does not match the identity document', mismatches: check.mismatches });
    }
    // The new answer and its event go together: if either fails, neither happens.
    const saved = await this.dataSource.transaction(async (manager) => {
      const row = await this.kyc.save(userId, submitted, manager);
      this.events.emit('kyc.birth_info.updated', { userId });
      return row;
    });
    // The answer is the document already read and the row just saved: no need to read either again.
    return view(userId, document, saved);
  }
}
