import { Injectable } from '@nestjs/common';
import type { ResidencyDeclarationDto } from './residency.types.ts';

export interface AddressCheck {
  confirmed: boolean;
  /** Why it wasn't confirmed, for the analyst. */
  reason?: string;
}

/** The external address verification service. */
@Injectable()
export class AddressCheckClient {
  async verify(address: ResidencyDeclarationDto): Promise<AddressCheck> {
    const res = await fetch('https://address-check.example.com/v1/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(address),
    });
    if (!res.ok) return { confirmed: false, reason: `address service answered ${res.status}` };
    const body = (await res.json()) as { match: 'exact' | 'partial' | 'none' };
    return body.match === 'exact' ? { confirmed: true } : { confirmed: false, reason: `address match: ${body.match}` };
  }
}
