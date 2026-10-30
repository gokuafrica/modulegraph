import { Db } from '../../platform/db.ts';
import { HttpClient } from '../../platform/http.ts';
import { TaxResidencyModule, type TaxResidency } from '../tax/TaxResidencyModule.ts';

/**
 * ComplianceReport: monthly regulator report of KYC outcomes and tax residencies.
 * @module
 * @owner team-compliance
 * @effect db.read kyc_results
 * @effect http regulator-reporting
 */
export class ComplianceReportModule {
  constructor(
    private readonly db: Db,
    private readonly http: HttpClient,
    private readonly tax: TaxResidencyModule,
  ) {}

  async generateMonthly(): Promise<void> {
    const results = await this.db.select('kyc_results', {});
    const residencies: TaxResidency[] = [];
    for (const row of results) residencies.push(await this.tax.assess(row.userId as string));
    await this.http.post('regulator-reporting', '/v1/reports', { results, residencies });
  }
}
