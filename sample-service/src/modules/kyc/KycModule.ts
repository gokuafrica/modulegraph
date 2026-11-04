import { Db } from '../../platform/db.ts';
import { Outbox } from '../../platform/outbox.ts';
import { BirthInfoModule } from '../birth-info/BirthInfoModule.ts';
import { IdentityModule } from '../identity/IdentityModule.ts';
import { NationalityModule } from '../nationality/NationalityModule.ts';
import { needsManualReview, riskTier, type RiskTier } from './riskTier.ts';
import { SanctionsScreening } from './SanctionsScreening.ts';

export type KycStatus = 'passed' | 'failed' | 'expired' | 'pending_review';

export interface KycResult {
  userId: string;
  status: KycStatus;
  riskTier?: RiskTier;
  checkedAt: string;
}

/**
 * Know-your-customer verification. Identity, birth info and nationality feed sanctions screening and a risk tier.
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
    const tier = riskTier({ countryOfBirth: birth.countryOfBirth, nationality: nationality.alpha3, screeningScore: screening.score });
    const previous = await this.getStatus(userId);
    const review = !screening.hit && needsManualReview(tier, previous);
    const status: KycStatus = screening.hit ? 'failed' : review ? 'pending_review' : 'passed';
    const result: KycResult = { userId, status, riskTier: tier, checkedAt: new Date().toISOString() };
    await this.persist(result, previous);
    if (review) {
      await this.outbox.enqueue('kyc.manual_review_requested', { userId, tier, listVersion: screening.listVersion });
    } else {
      await this.outbox.enqueue('kyc.completed', { ...result });
    }
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

  /** Nightly: re-screen expired results asynchronously instead of inside the cron job. */
  async recheckExpired(): Promise<number> {
    const expired = await this.db.select<KycResult & Record<string, unknown>>('kyc_results', { status: 'expired' });
    for (const row of expired) await this.outbox.enqueue('kyc.recheck_requested', { userId: row.userId });
    return expired.length;
  }

  /** One row per user: update the previous result instead of appending a new one. */
  private async persist(result: KycResult, previous: KycResult | undefined): Promise<void> {
    if (previous) await this.db.update('kyc_results', { userId: result.userId }, { ...result });
    else await this.db.insert('kyc_results', { ...result });
  }
}
