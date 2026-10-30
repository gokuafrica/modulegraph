export interface IdentityDocument {
  id: string;
  userId: string;
  kind: 'passport' | 'national_id' | 'birth_certificate';
  fileRef: string;
  uploadedAt: string;
}

export interface ExtractedFields {
  fullName: string;
  dateOfBirth: string;
  nationality: string;
  countryOfBirth: string;
  cityOfBirth: string;
}

/** Everything the platform knows about a user from their identity documents. Fetched once per request and shared. */
export interface IdentityData extends ExtractedFields {
  userId: string;
  documentIds: string[];
  extractedAt: string;
}
