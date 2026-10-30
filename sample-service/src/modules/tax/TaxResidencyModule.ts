import { Db } from '../../platform/db.ts';
import { BirthInfoModule } from '../birth-info/BirthInfoModule.ts';
import { IdentityModule } from '../identity/IdentityModule.ts';
import { NationalityModule } from '../nationality/NationalityModule.ts';

export interface TaxResidency {
  userId: string;
  residencies: string[];
  usPerson: boolean;
}

/**
 * TaxResidency: works out tax residencies (incl. US-person status from place of birth).
 * @module
 * @owner team-compliance
 * @effect db.read tax_declarations
 * @effect db.write tax_declarations
 * @effect db.read tax_residency_assessments
 * @effect db.write tax_residency_assessments
 */
export class TaxResidencyModule {
  constructor(
    private readonly db: Db,
    private readonly identity: IdentityModule,
    private readonly birthInfo: BirthInfoModule,
    private readonly nationality: NationalityModule,
  ) {}

  async assess(userId: string): Promise<TaxResidency> {
    const identity = await this.identity.fetchIdentity(userId);
    const birth = await this.birthInfo.resolve(identity);
    const nationality = await this.nationality.resolve(identity);
    const declarations = await this.db.select('tax_declarations', { userId });
    const residencies = [...new Set([nationality.alpha3, ...declarations.map((d) => d.country as string)])];
    const assessment = { userId, residencies, usPerson: birth.countryOfBirth === 'USA' || nationality.alpha3 === 'USA' };
    await this.db.insert('tax_residency_assessments', { ...assessment, assessedAt: new Date().toISOString() });
    return assessment;
  }

  async recordDeclaration(userId: string, country: string) {
    await this.db.insert('tax_declarations', { userId, country });
    return this.assess(userId);
  }

  async weeklySweep(): Promise<void> {
    const users = await this.db.select('tax_residency_assessments', {});
    for (const user of users) await this.assess(user.userId as string);
  }
}
