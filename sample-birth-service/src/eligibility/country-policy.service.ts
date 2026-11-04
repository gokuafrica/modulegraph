import { Injectable } from '@nestjs/common';

/** Countries of birth we can't onboard (sanctions programmes). */
const RESTRICTED = new Set(['PRK', 'IRN', 'SYR', 'CUB']);

/** Which countries of birth the product is available for. */
@Injectable()
export class CountryPolicy {
  isRestricted(countryOfBirth: string): boolean {
    return RESTRICTED.has(countryOfBirth.toUpperCase());
  }
}
