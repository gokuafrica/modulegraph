import { Body, Controller, Get, Param, Post, Query, UseGuards, Version } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Public, Roles } from '../common/auth.decorators.ts';
import { RolesGuard } from '../common/roles.guard.ts';
import { PaymentsService } from '../payments/payments.service.ts';
import { ListOrdersQuery, PlaceOrderCommand } from './commands.ts';
import { type PlaceOrderDto, Order } from './order.entity.ts';
import { OrdersService } from './orders.service.ts';

@Controller({ path: 'orders', version: '1' })
@UseGuards(RolesGuard)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
  ) {}

  @Public()
  @Get()
  list(@Query('customerId') customerId: string): Promise<Order[]> {
    return this.queries.execute(new ListOrdersQuery(customerId));
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<Order> {
    return this.orders.get(id);
  }

  @Version('2')
  @Get(':id')
  getV2(@Param('id') id: string): Promise<Order> {
    return this.orders.get(id);
  }

  @Roles(['clerk'])
  @Post()
  create(@Body() dto: PlaceOrderDto): Promise<Order> {
    return this.commands.execute(new PlaceOrderCommand(dto));
  }

  @Post(':id/hold')
  resolveHold(@Param('id') id: string, @Body() body: { approve: boolean }): Promise<void> {
    return this.orders.resolveHold(id, body.approve);
  }

  @Roles(['admin'])
  @Post('expire')
  expire(): Promise<number> {
    return this.orders.expireStale();
  }

  @Post(':id/pay')
  pay(@Param('id') id: string, @Body() body: { amount: number }): Promise<string> {
    return this.payments.charge(id, body.amount);
  }
}
