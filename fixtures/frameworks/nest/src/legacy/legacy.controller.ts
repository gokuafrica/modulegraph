import { Controller, Get, Param, Post } from '@nestjs/common';
import { OrdersService as LegacyOrdersService } from './orders.service.ts';

@Controller('legacy/orders')
export class LegacyOrdersController {
  constructor(private readonly orders: LegacyOrdersService) {}

  @Get(':id')
  get(@Param('id') id: string): Promise<unknown> {
    return this.orders.get(id);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string): Promise<void> {
    return this.orders.cancel(id);
  }
}
