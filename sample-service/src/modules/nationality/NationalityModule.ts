import { Db } from '../../platform/db.ts';
import type { IdentityData } from '../identity/types.ts';

export interface Nationality {
  alpha3: string;
  name: string;
  isEu: boolean;
}

/**
 * Nationality: normalises the document nationality to an ISO country record.
 * @module
 * @owner team-identity
 * @effect db.read country_codes
 */
export class NationalityModule {
  constructor(private readonly db: Db) {}

  async resolve(identity: IdentityData): Promise<Nationality> {
    const [country] = await this.db.select<Nationality & Record<string, unknown>>('country_codes', { alpha3: identity.nationality });
    return country ?? { alpha3: identity.nationality, name: identity.nationality, isEu: false };
  }
}
