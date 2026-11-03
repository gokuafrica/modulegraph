import { Db } from '../../platform/db.ts';
import { BirthInfoModule } from '../birth-info/BirthInfoModule.ts';
import { IdentityModule } from '../identity/IdentityModule.ts';

/**
 * Back-office view of a user's identity evidence for manual review.
 */
export class IdentityReviewModule {
  constructor(
    private readonly db: Db,
    private readonly identity: IdentityModule,
    private readonly birthInfo: BirthInfoModule,
  ) {}

  async review(userId: string) {
    const identity = await this.identity.fetchIdentity(userId);
    const birth = await this.birthInfo.resolve(identity);
    const notes = await this.db.select('review_notes', { userId });
    return { identity, birth, notes };
  }
}
