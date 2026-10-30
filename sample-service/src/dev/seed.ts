import type { buildApp } from '../app.ts';

type App = ReturnType<typeof buildApp>;

/** Two demo users: u-1 has only documents, u-2 has also given consented birth data. */
export async function seed(app: App): Promise<void> {
  const { db, http } = app;
  for (const userId of ['u-1', 'u-2']) {
    await db.insert('user_documents', { id: `doc-${userId}`, userId, kind: 'passport', fileRef: `s3://docs/${userId}.pdf`, uploadedAt: '2026-10-01' });
    await db.insert('user_profiles', { userId, preferredName: userId === 'u-1' ? 'Ana' : 'Raj' });
  }
  // u-2 corrected their birth city (Bombay on the passport, Mumbai by choice) and consented to its use.
  await db.insert('birth_info_consents', { userId: 'u-2', countryOfBirth: 'IND', cityOfBirth: 'Mumbai', consentedAt: '2026-10-20', revokedAt: null });
  await db.insert('country_codes', { alpha3: 'PRT', name: 'Portugal', isEu: true });
  await db.insert('country_codes', { alpha3: 'IND', name: 'India', isEu: false });

  http.stub('document-ai', (_path, body) => {
    const ref = (body as { fileRefs: string[] }).fileRefs[0];
    return ref.includes('u-1')
      ? { fullName: 'Ana Silva', dateOfBirth: '1990-04-12', nationality: 'PRT', countryOfBirth: 'PRT', cityOfBirth: 'Porto' }
      : { fullName: 'Raj Patel', dateOfBirth: '1988-09-30', nationality: 'IND', countryOfBirth: 'IND', cityOfBirth: 'Bombay' };
  });
  http.stub('sanctions-api', () => ({ hit: false, listVersion: '2026-10' }));
  http.stub('visa-rules-service', () => ({ visaRequired: false }));
  http.stub('regulator-reporting', () => ({ accepted: true }));
}
