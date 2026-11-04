import axios from 'axios';
import express from 'express';
import { Kafka } from 'kafkajs';
import cron from 'node-cron';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { invoicesRouter } from './routes/invoices.ts';
import { InvoiceService, PaymentGateway } from './services.ts';

export async function main(options: ConstructorParameters<typeof PrismaClient>[0]): Promise<void> {
  const kafka = new Kafka({ clientId: 'billing', brokers: ['localhost:9092'] });
  const producer = kafka.producer();
  const invoices = new InvoiceService(new PrismaClient(options), new PaymentGateway(axios.create({ baseURL: 'https://pay.example.com' })), producer);

  const app = express();
  app.use(express.json());
  app.use('/v1/invoices', invoicesRouter(invoices));
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  const consumer = kafka.consumer({ groupId: 'billing' });
  await consumer.subscribe({ topics: ['payments.settled'] });
  await consumer.run({
    eachMessage: async ({ message }) => {
      await invoices.markSettled(String(message.key));
    },
  });

  cron.schedule('0 6 * * *', () => invoices.remindOverdue(), { name: 'overdue-reminders' });
  app.listen(3000);
}
