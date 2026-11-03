import { Db } from '../../platform/db.ts';
import { KafkaProducer } from '../../platform/kafka.ts';
import { BirthInfoModule } from '../birth-info/BirthInfoModule.ts';
import { IdentityModule } from '../identity/IdentityModule.ts';
import { NationalityModule } from '../nationality/NationalityModule.ts';
import { PersonalDetailsModule } from '../personal-details/PersonalDetailsModule.ts';

/**
 * Builds the user profile. Fetches Identity once and shares it with every sub-module.
 */
export class ProfileService {
  constructor(
    private readonly db: Db,
    private readonly kafka: KafkaProducer,
    private readonly identity: IdentityModule,
    private readonly nationality: NationalityModule,
    private readonly personalDetails: PersonalDetailsModule,
    private readonly birthInfo: BirthInfoModule,
  ) {}

  async getProfile(userId: string) {
    const identity = await this.identity.fetchIdentity(userId);
    const [nationality, personal, birth] = await Promise.all([
      this.nationality.resolve(identity),
      this.personalDetails.resolve(userId, identity),
      this.birthInfo.resolve(identity),
    ]);
    return { userId, nationality, personal, birth };
  }

  async getSummary(userId: string) {
    const identity = await this.identity.fetchIdentity(userId);
    const personal = await this.personalDetails.resolve(userId, identity);
    return { userId, name: personal.preferredName };
  }

  async getNationality(userId: string) {
    const identity = await this.identity.fetchIdentity(userId);
    return this.nationality.resolve(identity);
  }

  async getBirthInfo(userId: string) {
    const identity = await this.identity.fetchIdentity(userId);
    return this.birthInfo.resolve(identity);
  }

  async exportProfile(userId: string) {
    const profile = await this.getProfile(userId);
    await this.db.insert('gdpr_exports', { userId, profile, exportedAt: new Date().toISOString() });
    await this.kafka.produce('privacy.export.ready', { userId });
    return { status: 'queued' };
  }

  async purge(userId: string) {
    await this.db.delete('user_profiles', { userId });
    await this.db.delete('user_documents', { userId });
    return { purged: true };
  }
}
