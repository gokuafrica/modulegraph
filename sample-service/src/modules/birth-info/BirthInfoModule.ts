import type { IdentityData } from '../identity/types.ts';
import { DocumentBirthExtractor } from './DocumentBirthExtractor.ts';
import type { BirthInfo } from './types.ts';

/**
 * The user's country and city of birth.
 */
export class BirthInfoModule {
  constructor(private readonly documentBirth: DocumentBirthExtractor) {}

  async resolve(identity: IdentityData): Promise<BirthInfo> {
    return this.documentBirth.fromIdentity(identity);
  }
}
