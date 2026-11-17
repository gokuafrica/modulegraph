import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD, RouterModule } from '@nestjs/core';
import { CqrsModule } from '@nestjs/cqrs';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from './admin/admin.module.ts';
import { AuditEntry, AuditService } from './audit/audit.service.ts';
import { AuthGuard } from './common/auth.guard.ts';
import { RequestIdMiddleware } from './common/request-id.middleware.ts';
import { OrdersResolver } from './graphql/orders.resolver.ts';
import { LegacyOrdersController } from './legacy/legacy.controller.ts';
import { OrdersService as LegacyOrdersService } from './legacy/orders.service.ts';
import { EmailNotifier, NOTIFIER } from './notifications/notifier.ts';
import { ListOrdersHandler, OrderPlacedHandler, PlaceOrderHandler } from './orders/commands.ts';
import { Order } from './orders/order.entity.ts';
import { OrdersController } from './orders/orders.controller.ts';
import { OrdersService } from './orders/orders.service.ts';
import { PAYMENT_GATEWAY, StripeGateway } from './payments/gateway.ts';
import { PaymentsService } from './payments/payments.service.ts';
import { Review, ReviewSchema } from './reviews/review.schema.ts';
import { ReviewsController } from './reviews/reviews.controller.ts';
import { ReviewsService } from './reviews/reviews.service.ts';
import { Session, SessionsService } from './sessions/sessions.service.ts';
import { OrdersGateway } from './ws/orders.gateway.ts';

@Module({
  imports: [
    TypeOrmModule.forRoot({ type: 'postgres', url: process.env.DATABASE_URL, entities: [Order, Session, AuditEntry] }),
    TypeOrmModule.forFeature([Order, Session, AuditEntry]),
    MongooseModule.forRoot(process.env.MONGO_URL ?? 'mongodb://localhost/store'),
    MongooseModule.forFeature([{ name: Review.name, schema: ReviewSchema }]),
    CqrsModule.forRoot(),
    AdminModule,
    RouterModule.register([{ path: 'admin', module: AdminModule }]),
  ],
  controllers: [OrdersController, LegacyOrdersController, ReviewsController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: PAYMENT_GATEWAY, useClass: StripeGateway },
    { provide: NOTIFIER, useFactory: () => new EmailNotifier() },
    OrdersService, LegacyOrdersService, PaymentsService, ReviewsService, SessionsService, AuditService,
    PlaceOrderHandler, ListOrdersHandler, OrderPlacedHandler, OrdersResolver, OrdersGateway,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes(OrdersController, 'reviews');
  }
}
