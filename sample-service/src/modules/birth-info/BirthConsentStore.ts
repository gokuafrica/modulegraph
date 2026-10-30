import { Db } from '../../platform/db.ts';
import type { ConsentedBirthData } from './types.ts';

/**
 * Stores birth data the user consented to share.
 */
export class BirthConsentStore {
  constructor(private readonly db: Db) {}

  async findActiveConsent(userId: string): Promise<ConsentedBirthData | undefined> {
    const rows = await this.db.select<ConsentedBirthData & Record<string, unknown>>('birth_info_consents', { userId, revokedAt: null });
    return rows.at(-1);
  }

  async recordConsent(userId: string, countryOfBirth: string, cityOfBirth: string): Promise<void> {
    await this.db.update('birth_info_consents', { userId, revokedAt: null }, { revokedAt: new Date().toISOString() });
    await this.db.insert('birth_info_consents', { userId, countryOfBirth, cityOfBirth, consentedAt: new Date().toISOString(), revokedAt: null });
  }
}
