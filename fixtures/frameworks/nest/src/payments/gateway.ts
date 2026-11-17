import { Injectable } from '@nestjs/common';

export const PAYMENT_GATEWAY = 'PAYMENT_GATEWAY';

export interface PaymentGateway {
  charge(orderId: string, amount: number): Promise<string>;
}

/** The real gateway, bound to PAYMENT_GATEWAY in AppModule. */
@Injectable()
export class StripeGateway implements PaymentGateway {
  async charge(orderId: string, amount: number): Promise<string> {
    const res = await fetch('https://api.stripe.example/v1/charges', { method: 'POST', body: JSON.stringify({ orderId, amount }) });
    return ((await res.json()) as { id: string }).id;
  }
}

/** For local runs; not bound in AppModule. */
@Injectable()
export class FakeGateway implements PaymentGateway {
  async charge(orderId: string): Promise<string> {
    return `fake-${orderId}`;
  }
}
