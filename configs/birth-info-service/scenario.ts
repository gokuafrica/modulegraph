import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * Example requests for birth-info-service, run by modulegraph to record real module inputs and outputs.
 * Lives outside the service: it loads the revision under review from `projectRoot` and wires the providers by
 * hand with in-memory tables (no database, no Nest container). Each request is one `step`, so the UI can follow
 * the same request (same user, same data) through every module.
 *
 * What the document pipeline extracted:
 *   u-1 Ana   PRT / Porto        full document
 *   u-2 Raj   IND / (unreadable) country only
 *   u-3 Lena  nothing            extraction failed
 *   u-4 Tunde (unreadable) / Lagos   place only
 */
type Step = <T>(label: string, fn: () => Promise<T> | T) => Promise<T | undefined>;

function table<T extends { userId: string }>(rows: T[]) {
  const byId = new Map(rows.map((r) => [r.userId, r]));
  return {
    findOneBy: async ({ userId }: { userId: string }) => byId.get(userId) ?? null,
    save: async (row: T) => (byId.set(row.userId, row), row),
  };
}

export default async function scenario(projectRoot: string, { step }: { step: Step }): Promise<void> {
  const load = (path: string) => import(pathToFileURL(join(projectRoot, path)).href);
  const { DocumentBirthInfoService } = await load('src/documents/document-birth-info.service.ts');
  const { KycBirthInfoStore } = await load('src/birth-info/kyc-birth-info.store.ts');
  const { BirthInfoService } = await load('src/birth-info/birth-info.service.ts');
  const { BirthInfoController } = await load('src/birth-info/birth-info.controller.ts');
  const { CountryPolicy } = await load('src/eligibility/country-policy.service.ts');
  const { EligibilityService } = await load('src/eligibility/eligibility.service.ts');
  const { EligibilityController } = await load('src/eligibility/eligibility.controller.ts');
  // The branch adds a provider; wire it when it exists.
  const verifierFile = 'src/birth-info/birth-info-verifier.ts';
  const verifier = await load(verifierFile).then((m) => new m.BirthInfoVerifier(), () => undefined);

  const documents = new DocumentBirthInfoService(table([
    { userId: 'u-1', countryOfBirth: 'PRT', placeOfBirth: 'Porto', documentId: 'passport-u-1' },
    { userId: 'u-2', countryOfBirth: 'IND', placeOfBirth: null, documentId: 'passport-u-2' },
    { userId: 'u-3', countryOfBirth: null, placeOfBirth: null, documentId: 'id-card-u-3' },
    { userId: 'u-4', countryOfBirth: null, placeOfBirth: 'Lagos', documentId: 'passport-u-4' },
  ]));
  const kycRows = table([
    { userId: 'u-1', countryOfBirth: 'PRT', placeOfBirth: 'Porto', updatedAt: '2026-10-01T09:00:00.000Z' },
  ]);
  const kyc = new KycBirthInfoStore(kycRows);
  // In-memory "transaction": the callback runs with a manager whose repositories are the same tables.
  const dataSource = { transaction: async <T>(work: (manager: { getRepository: () => typeof kycRows }) => Promise<T>) => work({ getRepository: () => kycRows }) };
  const birthInfo = verifier
    ? new BirthInfoService(documents, kyc, verifier, new EventEmitter2(), dataSource)
    : new BirthInfoService(documents, kyc, new EventEmitter2());
  const birthApi = new BirthInfoController(birthInfo);
  const eligibilityApi = new EligibilityController(new EligibilityService(birthInfo, new CountryPolicy()));

  const get = (user: string) => step(`GET /users/${user}/birth-info`, () => birthApi.get(user));
  const eligibility = (user: string) => step(`GET /users/${user}/eligibility`, () => eligibilityApi.check(user));
  const post = (user: string, countryOfBirth: string, placeOfBirth: string, why: string) =>
    step(`POST /users/${user}/birth-info ${countryOfBirth}/${placeOfBirth} (${why})`, () => birthApi.update(user, { countryOfBirth, placeOfBirth }));

  for (const user of ['u-1', 'u-2', 'u-3', 'u-4']) {
    await get(user);
    await eligibility(user);
  }
  await post('u-1', 'PRT', 'Porto', 'matches document');
  await post('u-1', 'ESP', 'Madrid', 'contradicts document');
  await post('u-2', 'IND', 'Mumbai', 'country matches, document has no place');
  await post('u-2', 'PAK', 'Lahore', 'country contradicts document');
  await post('u-3', 'DEU', 'Berlin', 'no document data');
  await post('u-4', 'nga', 'lagos', 'place matches, document has no country');
  await post('u-4', 'NGA', 'Abuja', 'place contradicts document');
  for (const user of ['u-1', 'u-2', 'u-3', 'u-4']) await eligibility(user);
}
