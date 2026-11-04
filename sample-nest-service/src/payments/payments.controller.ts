import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { NotificationsService } from '../notifications/notifications.service.ts';
import { type Payment, PaymentsService, type ProviderEvent } from './payments.service.ts';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('webhook')
  webhook(@Body() event: ProviderEvent): Promise<Payment> {
    return this.payments.handleWebhook(event);
  }

  @Get(':orderId')
  forOrder(@Param('orderId') orderId: string): Promise<Payment[]> {
    return this.payments.forOrder(orderId);
  }
}

/** Sends a receipt for every settled payment (jobs from the receipts queue). */
@Processor('receipts')
export class ReceiptProcessor extends WorkerHost {
  constructor(private readonly notifications: NotificationsService) {
    super();
  }

  async process(job: Job<{ paymentId: string }>): Promise<void> {
    await this.notifications.receipt(job.data.paymentId);
  }
}
