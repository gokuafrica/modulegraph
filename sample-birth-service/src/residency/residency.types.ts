/** The home address a user declares during KYC. */
export interface ResidencyDeclarationDto {
  /** ISO 3166-1 alpha-3, e.g. "PRT". */
  countryOfResidence: string;
  city: string;
  postalCode: string;
  addressLine: string;
}

/** `verified`: the address service confirmed the address. `pending_review`: it couldn't, so an analyst checks it. */
export type ResidencyStatus = 'verified' | 'pending_review';

/** A user's residency as the API returns it. */
export interface ResidencyView {
  userId: string;
  /** The latest declaration. Null until the user declares one. */
  current: (ResidencyDeclarationDto & { status: ResidencyStatus; declaredAt: string }) | null;
  /** How many declarations the user has made, the current one included. */
  declarations: number;
}
