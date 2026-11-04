// Billing API on Express + Prisma + KafkaJS + axios. Plain classes wired by hand in main.ts.
import axios, { type AxiosInstance } from 'axios';
import type { Producer } from 'kafkajs';
import type { PrismaClient } from '../../generated/prisma/client.ts';

export interface Invoice {
  id: string;
  customerId: string;
  amount: number;
  status: string;
}

export class PaymentGateway {
  constructor(private readonly http: AxiosInstance) {}

  async charge(invoiceId: string, amount: number): Promise<{ chargeId: string }> {
    const res = await this.http.post<{ chargeId: string }>('/v1/charges', { invoiceId, amount });
    return res.data;
  }

  async fxRate(currency: string): Promise<number> {
    const res = await axios.get<{ rate: number }>(`https://fx.example.com/v2/rates/${currency}`);
    return res.data.rate;
  }
}

export class InvoiceService {
  constructor(
    private readonly db: PrismaClient,
    private readonly payments: PaymentGateway,
    private readonly producer: Producer,
  ) {}

  async issue(customerId: string, amount: number): Promise<Invoice> {
    const customer = await this.db.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new Error(`no customer ${customerId}`);
    const invoice = await this.db.invoice.create({ data: { id: crypto.randomUUID(), customerId, amount, status: 'open' } });
    await this.producer.send({ topic: 'invoices.issued', messages: [{ value: JSON.stringify({ id: invoice.id }) }] });
    return { ...invoice, amount: Number(invoice.amount) };
  }

  async get(id: string): Promise<Invoice | null> {
    const invoice = await this.db.invoice.findUnique({ where: { id } });
    return invoice && { ...invoice, amount: Number(invoice.amount) };
  }

  async pay(id: string): Promise<{ chargeId: string }> {
    const invoice = await this.db.invoice.findUniqueOrThrow({ where: { id } });
    const charge = await this.payments.charge(id, Number(invoice.amount));
    await this.db.invoice.update({ where: { id }, data: { status: 'paid' } });
    return charge;
  }

  async markSettled(id: string): Promise<void> {
    await this.db.invoice.update({ where: { id }, data: { status: 'settled' } });
  }

  async remindOverdue(): Promise<number> {
    const overdue = await this.db.invoice.findMany({ where: { status: 'open' } });
    for (const invoice of overdue) {
      await this.producer.send({ topic: 'invoices.reminder', messages: [{ value: invoice.id }] });
    }
    return overdue.length;
  }
}
