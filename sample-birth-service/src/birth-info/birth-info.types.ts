/** Where someone was born. Either part may be unknown. */
export interface BirthPlace {
  /** ISO 3166-1 alpha-3, e.g. "PRT". */
  countryOfBirth?: string;
  /** City or town, e.g. "Porto". */
  placeOfBirth?: string;
}

/** What the user told us during KYC. Both parts are required when they submit it. */
export interface KycBirthInfoDto {
  countryOfBirth: string;
  placeOfBirth: string;
}

/** A user's birth info as the API returns it: what their document says, and what they told us. */
export interface BirthInfoView {
  userId: string;
  /** Extracted from the identity document. Null when extraction found nothing. */
  document: BirthPlace | null;
  /** Provided by the user during KYC. Null until they submit it. */
  kyc: (KycBirthInfoDto & { updatedAt: string }) | null;
}
