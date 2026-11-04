import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { OnEvent } from '@nestjs/event-emitter';
import type { Job, Queue } from 'bullmq';
import { firstValueFrom } from 'rxjs';
import type { Order } from '../orders/order.entity.ts';

/** Notifications: queues customer emails; the email worker sends them through the mail provider. */
@Injectable()
export class NotificationsService {
  constructor(@InjectQueue('emails') private readonly emails: Queue) {}

  async orderConfirmation(order: Order & { email: string }): Promise<void> {
    await this.emails.add('order-confirmation', { to: order.email, orderId: order.id, total: order.total });
  }

  async receipt(paymentId: string): Promise<void> {
    await this.emails.add('receipt', { paymentId });
  }
}

@Injectable()
export class MailClient {
  constructor(private readonly http: HttpService) {}

  async send(template: string, data: unknown): Promise<void> {
    await firstValueFrom(this.http.post('https://mail.example.com/v3/send', { template, data }));
  }
}

@Processor('emails')
export class EmailProcessor extends WorkerHost {
  constructor(private readonly mail: MailClient) {
    super();
  }

  async process(job: Job): Promise<void> {
    await this.mail.send(job.name, job.data);
  }
}

/** In-process order events → customer notifications. */
@Injectable()
export class OrderNotificationsListener {
  constructor(private readonly notifications: NotificationsService) {}

  @OnEvent('order.created')
  async onCreated(order: Order & { email: string }): Promise<void> {
    await this.notifications.orderConfirmation(order);
  }
}
