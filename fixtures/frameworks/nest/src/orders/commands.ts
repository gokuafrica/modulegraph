import { Inject } from '@nestjs/common';
import { CommandHandler, EventBus, EventsHandler, type ICommandHandler, type IEventHandler, type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NOTIFIER, Notifier } from '../notifications/notifier.ts';
import { type PlaceOrderDto, Order } from './order.entity.ts';

export class PlaceOrderCommand {
  constructor(readonly dto: PlaceOrderDto) {}
}

export class ListOrdersQuery {
  constructor(readonly customerId: string) {}
}

export class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

@CommandHandler(PlaceOrderCommand)
export class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand> {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly events: EventBus,
  ) {}

  async execute(command: PlaceOrderCommand): Promise<Order> {
    const order = await this.orders.save({ ...command.dto, status: 'pending', createdAt: new Date() });
    this.events.publish(new OrderPlacedEvent(order.id));
    return order;
  }
}

@QueryHandler(ListOrdersQuery)
export class ListOrdersHandler implements IQueryHandler<ListOrdersQuery> {
  constructor(@InjectRepository(Order) private readonly orders: Repository<Order>) {}

  async execute(query: ListOrdersQuery): Promise<Order[]> {
    return this.orders.createQueryBuilder('o').where('o.customer_id = :id', { id: query.customerId }).getMany();
  }
}

@EventsHandler(OrderPlacedEvent)
export class OrderPlacedHandler implements IEventHandler<OrderPlacedEvent> {
  constructor(@Inject(NOTIFIER) private readonly notifier: Notifier) {}

  async handle(event: OrderPlacedEvent): Promise<void> {
    await this.notifier.send(`order ${event.orderId} placed`);
  }
}
