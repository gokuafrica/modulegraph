import { Outbox } from '../../platform/outbox.ts';
import type { IdentityData } from '../identity/types.ts';
import { BirthConsentStore } from './BirthConsentStore.ts';
import { DocumentBirthExtractor } from './DocumentBirthExtractor.ts';
import type { BirthInfo } from './types.ts';

/**
 * The user's country and city of birth. Consented user data wins; documents are the fallback.
 */
export class BirthInfoModule {
  constructor(
    private readonly documentBirth: DocumentBirthExtractor,
    private readonly consents: BirthConsentStore,
    private readonly outbox: Outbox,
  ) {}

  async resolve(identity: IdentityData): Promise<BirthInfo> {
    const consented = await this.consents.findActiveConsent(identity.userId);
    if (consented) {
      // Consented data replaces document data as a whole; fields are never mixed across sources.
      const info: BirthInfo = { countryOfBirth: consented.countryOfBirth, cityOfBirth: consented.cityOfBirth, source: 'consent' };
      await this.outbox.enqueue('birth_info.source_resolved', { userId: identity.userId, source: info.source });
      return info;
    }
    return this.documentBirth.fromIdentity(identity);
  }

  async recordConsent(userId: string, countryOfBirth: string, cityOfBirth: string): Promise<void> {
    await this.consents.recordConsent(userId, countryOfBirth, cityOfBirth);
  }
}
