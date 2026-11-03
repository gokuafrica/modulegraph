import { Db } from '../../platform/db.ts';
import type { IdentityData } from '../identity/types.ts';

export interface PersonalDetails {
  legalName: string;
  preferredName: string;
  dateOfBirth: string;
}

/**
 * Legal name and date of birth from documents, preferred name from the user's profile.
 */
export class PersonalDetailsModule {
  constructor(private readonly db: Db) {}

  async resolve(userId: string, identity: IdentityData): Promise<PersonalDetails> {
    const [profile] = await this.db.select('user_profiles', { userId });
    return {
      legalName: identity.fullName,
      preferredName: (profile?.preferredName as string | undefined) ?? identity.fullName,
      dateOfBirth: identity.dateOfBirth,
    };
  }
}
