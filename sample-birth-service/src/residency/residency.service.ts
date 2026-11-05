import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CountryPolicy } from '../eligibility/country-policy.service.ts';
import { AddressCheckClient } from './address-check.client.ts';
import type { ResidencyDeclarationDto, ResidencyView } from './residency.types.ts';
import { ResidencyStore } from './residency.store.ts';

/** Where a user lives, as they declared it during KYC. */
@Injectable()
export class ResidencyService {
  constructor(
    private readonly store: ResidencyStore,
    private readonly addressCheck: AddressCheckClient,
    private readonly policy: CountryPolicy,
    private readonly events: EventEmitter2,
  ) {}

  async get(userId: string): Promise<ResidencyView> {
    const [latest, declarations] = await Promise.all([this.store.latest(userId), this.store.count(userId)]);
    return {
      userId,
      current: latest
        ? {
            countryOfResidence: latest.countryOfResidence, city: latest.city, postalCode: latest.postalCode,
            addressLine: latest.addressLine, status: latest.status, declaredAt: latest.declaredAt,
          }
        : null,
      declarations,
    };
  }

  /**
   * Records a new home address for the user. Residents of restricted countries are rejected. The address service
   * confirms the address; if it can't, the declaration is kept as pending review for an analyst.
   */
  async declare(userId: string, dto: ResidencyDeclarationDto): Promise<ResidencyView> {
    const address = {
      countryOfResidence: dto.countryOfResidence.trim().toUpperCase(),
      city: dto.city.trim(),
      postalCode: dto.postalCode.replace(/\s+/g, '').toUpperCase(),
      addressLine: dto.addressLine.trim(),
    };
    if (this.policy.isRestricted(address.countryOfResidence)) {
      throw new UnprocessableEntityException({ message: `Residents of ${address.countryOfResidence} can't be onboarded` });
    }
    const check = await this.addressCheck.verify(address);
    const status = check.confirmed ? 'verified' : 'pending_review';
    await this.store.add(userId, address, status);
    this.events.emit('kyc.residency.declared', { userId, status, reason: check.reason });
    return this.get(userId);
  }
}
