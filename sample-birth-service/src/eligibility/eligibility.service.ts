import { Injectable } from '@nestjs/common';
import { BirthInfoService } from '../birth-info/birth-info.service.ts';
import type { BirthPlace } from '../birth-info/birth-info.types.ts';
import { CountryPolicy } from './country-policy.service.ts';

export interface Eligibility {
  userId: string;
  eligible: boolean;
  /** Why not, when not eligible. */
  reasons: string[];
  /** The birth place the decision used, and where it came from. */
  basedOn: BirthPlace & { source: 'kyc' | 'document' | 'none' };
}

/** Decides whether a user is eligible, given what we know about their birth. */
@Injectable()
export class EligibilityService {
  constructor(
    private readonly birthInfo: BirthInfoService,
    private readonly policy: CountryPolicy,
  ) {}

  async check(userId: string): Promise<Eligibility> {
    const info = await this.birthInfo.get(userId);
    // The user's own (KYC) answer is the one we hold them to; the document is the fallback.
    const basedOn = info.kyc
      ? { source: 'kyc' as const, countryOfBirth: info.kyc.countryOfBirth, placeOfBirth: info.kyc.placeOfBirth }
      : info.document
        ? { source: 'document' as const, ...info.document }
        : { source: 'none' as const };
    const reasons: string[] = [];
    if (!basedOn.countryOfBirth) reasons.push('country of birth unknown');
    else if (this.policy.isRestricted(basedOn.countryOfBirth)) reasons.push(`country of birth ${basedOn.countryOfBirth} is restricted`);
    if (!basedOn.placeOfBirth) reasons.push('place of birth unknown');
    return { userId, eligible: reasons.length === 0, reasons, basedOn };
  }
}
