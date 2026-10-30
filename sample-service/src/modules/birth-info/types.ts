export interface BirthInfo {
  countryOfBirth: string;
  cityOfBirth: string;
  /** Where the values came from. Consented data always wins over document data. */
  source: 'consent' | 'document';
}

/** Birth data the user explicitly provided and consented to us using. */
export interface ConsentedBirthData {
  userId: string;
  countryOfBirth: string;
  cityOfBirth: string;
  consentedAt: string;
  revokedAt: string | null;
}
