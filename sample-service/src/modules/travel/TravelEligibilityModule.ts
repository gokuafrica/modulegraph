import { Db } from '../../platform/db.ts';
import { HttpClient } from '../../platform/http.ts';
import { BirthInfoModule } from '../birth-info/BirthInfoModule.ts';
import { IdentityModule } from '../identity/IdentityModule.ts';
import { NationalityModule } from '../nationality/NationalityModule.ts';
import { PersonalDetailsModule } from '../personal-details/PersonalDetailsModule.ts';

/**
 * Visa eligibility checks and passport application prefill.
 */
export class TravelEligibilityModule {
  constructor(
    private readonly db: Db,
    private readonly http: HttpClient,
    private readonly identity: IdentityModule,
    private readonly nationality: NationalityModule,
    private readonly personalDetails: PersonalDetailsModule,
    private readonly birthInfo: BirthInfoModule,
  ) {}

  async checkVisa(userId: string, destination: string) {
    const identity = await this.identity.fetchIdentity(userId);
    const [nationality, birth] = await Promise.all([this.nationality.resolve(identity), this.birthInfo.resolve(identity)]);
    const path = `/v1/rules?from=${nationality.alpha3}&born=${birth.countryOfBirth}&to=${destination}`;
    const rules = await this.http.get<{ visaRequired: boolean }>('visa-rules-service', path);
    return { destination, visaRequired: rules.visaRequired };
  }

  async prefillPassport(userId: string) {
    const identity = await this.identity.fetchIdentity(userId);
    const [personal, birth, nationality] = await Promise.all([
      this.personalDetails.resolve(userId, identity),
      this.birthInfo.resolve(identity),
      this.nationality.resolve(identity),
    ]);
    const prefill = { userId, ...personal, ...birth, nationality: nationality.alpha3 };
    await this.db.insert('passport_prefills', prefill);
    return prefill;
  }
}
