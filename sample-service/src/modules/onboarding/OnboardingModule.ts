import { Db } from '../../platform/db.ts';
import { KafkaProducer } from '../../platform/kafka.ts';
import { KycModule } from '../kyc/KycModule.ts';

/**
 * Onboarding: completes sign-up once KYC passes.
 * @module
 * @owner team-onboarding
 * @effect db.write users
 * @effect kafka user.onboarded
 */
export class OnboardingModule {
  constructor(
    private readonly db: Db,
    private readonly kafka: KafkaProducer,
    private readonly kyc: KycModule,
  ) {}

  async complete(userId: string) {
    const kyc = await this.kyc.runCheck(userId);
    if (kyc.status !== 'passed') return { userId, onboarded: false };
    await this.db.update('users', { userId }, { status: 'active' });
    await this.kafka.produce('user.onboarded', { userId });
    return { userId, onboarded: true };
  }
}
