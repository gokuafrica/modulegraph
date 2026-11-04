import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEntry, AuditService } from './audit/audit.service.ts';
import { AuthGuard } from './common/auth.guard.ts';
import { Customer, CustomersService } from './customers/customers.service.ts';
import { InventoryService, StockItem } from './inventory/inventory.service.ts';
import { ScheduledJobs } from './jobs/jobs.ts';
import { EmailProcessor, MailClient, NotificationsService, OrderNotificationsListener } from './notifications/notifications.service.ts';
import { Order, OrderLineRow } from './orders/order.entity.ts';
import { OrderEventsController, OrdersController } from './orders/orders.controller.ts';
import { OrdersService } from './orders/orders.service.ts';
import { PaymentsController, ReceiptProcessor } from './payments/payments.controller.ts';
import { Payment, PaymentsService } from './payments/payments.service.ts';
import { PricingService, Product, TaxClient } from './pricing/pricing.service.ts';
import { Promotion, PromotionRedemption, PromotionsService } from './pricing/promotions.service.ts';
import { CarrierClient, Shipment, ShippingService } from './shipping/shipping.service.ts';

const entities = [Order, OrderLineRow, Customer, Product, Promotion, PromotionRedemption, StockItem, Shipment, Payment, AuditEntry];

@Module({
  imports: [
    TypeOrmModule.forRoot({ type: 'postgres', url: process.env.DATABASE_URL, entities }),
    TypeOrmModule.forFeature(entities),
    HttpModule,
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    BullModule.forRoot({ connection: { url: process.env.REDIS_URL } }),
    BullModule.registerQueue({ name: 'emails' }, { name: 'receipts' }),
    ClientsModule.register([{ name: 'ORDER_EVENTS', transport: Transport.KAFKA, options: { client: { brokers: [process.env.KAFKA_BROKER ?? 'localhost:9092'] } } }]),
  ],
  controllers: [OrdersController, OrderEventsController, PaymentsController],
  providers: [
    OrdersService, CustomersService, PricingService, PromotionsService, TaxClient, ShippingService, CarrierClient,
    InventoryService, PaymentsService, NotificationsService, MailClient, AuditService,
    EmailProcessor, ReceiptProcessor, OrderNotificationsListener, ScheduledJobs, AuthGuard,
  ],
})
export class AppModule {}
