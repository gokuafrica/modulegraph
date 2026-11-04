import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { EventPattern, GrpcMethod, Payload } from '@nestjs/microservices';
import { AuthGuard } from '../common/auth.guard.ts';
import { type CreateOrderDto, Order } from './order.entity.ts';
import { OrdersService } from './orders.service.ts';

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(@Body() dto: CreateOrderDto): Promise<Order> {
    return this.orders.create(dto);
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<Order> {
    return this.orders.get(id);
  }

  @Get()
  list(@Query('customerId') customerId: string): Promise<Order[]> {
    return this.orders.list(customerId);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string): Promise<Order> {
    return this.orders.cancel(id);
  }
}

/** Kafka events from other services, and the gRPC API other services call. */
@Controller()
export class OrderEventsController {
  constructor(private readonly orders: OrdersService) {}

  @EventPattern('payments.settled')
  async onPaymentSettled(@Payload() event: { orderId: string; paymentId: string }): Promise<void> {
    await this.orders.markPaid(event.orderId, event.paymentId);
  }

  @EventPattern('shipments.dispatched')
  async onDispatched(@Payload() event: { orderId: string }): Promise<void> {
    await this.orders.markShipped(event.orderId);
  }

  @GrpcMethod('OrderService', 'GetOrder')
  getOrder(data: { id: string }): Promise<Order> {
    return this.orders.get(data.id);
  }
}
