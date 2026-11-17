import { Inject, Injectable } from '@nestjs/common';
import { PAYMENT_GATEWAY, type PaymentGateway } from './gateway.ts';

@Injectable()
export class PaymentsService {
  constructor(@Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway) {}

  async charge(orderId: string, amount: number): Promise<string> {
    return this.gateway.charge(orderId, amount);
  }
}
