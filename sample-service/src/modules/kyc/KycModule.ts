import { Db } from '../../platform/db.ts';
import { Outbox } from '../../platform/outbox.ts';
import { BirthInfoModule } from '../birth-info/BirthInfoModule.ts';
import { IdentityModule } from '../identity/IdentityModule.ts';
import { NationalityModule } from '../nationality/NationalityModule.ts';
import { SanctionsScreening } from './SanctionsScreening.ts';

export type KycStatus = 'passed' | 'failed' | 'expired';

export interface KycResult {
  userId: string;
  status: KycStatus;
  checkedAt: string;
}

/**
 * KycCheck: know-your-customer verification. Identity, birth info and nationality feed sanctions screening.
 * @module
 * @owner team-compliance
 * @effect db.read kyc_results
 * @effect db.write kyc_results
 * @effect outbox kyc.completed
 * @effect outbox kyc.overridden
 */
export class KycModule {
  constructor(
    private readonly db: Db,
    private readonly outbox: Outbox,
    private readonly identity: IdentityModule,
    private readonly birthInfo: BirthInfoModule,
    private readonly nationality: NationalityModule,
    private readonly sanctions: SanctionsScreening,
  ) {}

  async runCheck(userId: string): Promise<KycResult> {
    const identity = await this.identity.fetchIdentity(userId);
    const [birth, nationality] = await Promise.all([this.birthInfo.resolve(identity), this.nationality.resolve(identity)]);
    const screening = await this.sanctions.screen({
      name: identity.fullName,
      countryOfBirth: birth.countryOfBirth,
      nationality: nationality.alpha3,
    });
    const result: KycResult = { userId, status: screening.hit ? 'failed' : 'passed', checkedAt: new Date().toISOString() };
    await this.db.insert('kyc_results', { ...result });
    await this.outbox.enqueue('kyc.completed', { ...result });
    return result;
  }

  async getStatus(userId: string): Promise<KycResult | undefined> {
    const [latest] = await this.db.select<KycResult & Record<string, unknown>>('kyc_results', { userId });
    return latest;
  }

  async override(userId: string, status: KycStatus, reviewer: string) {
    await this.db.update('kyc_results', { userId }, { status, overriddenBy: reviewer });
    await this.outbox.enqueue('kyc.overridden', { userId, status, reviewer });
    return { userId, status };
  }

  async recheckExpired(): Promise<number> {
    const expired = await this.db.select<KycResult & Record<string, unknown>>('kyc_results', { status: 'expired' });
    for (const row of expired) await this.runCheck(row.userId);
    return expired.length;
  }
}
