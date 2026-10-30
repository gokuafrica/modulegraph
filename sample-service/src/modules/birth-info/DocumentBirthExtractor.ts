import type { IdentityData } from '../identity/types.ts';
import type { BirthInfo } from './types.ts';

/**
 * Reads country and city of birth out of already-fetched identity data. Pure: no I/O.
 * @module
 * @owner team-identity
 */
export class DocumentBirthExtractor {
  fromIdentity(identity: IdentityData): BirthInfo {
    return { countryOfBirth: identity.countryOfBirth, cityOfBirth: identity.cityOfBirth };
  }
}
