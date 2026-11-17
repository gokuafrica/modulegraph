import { Args, Field, Mutation, ObjectType, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { OrdersService } from '../orders/orders.service.ts';
import { SessionsService } from '../sessions/sessions.service.ts';

@ObjectType('Order')
export class OrderType {
  @Field() id: string;
  @Field() customerId: string;
  @Field() status: string;
}

@Resolver(() => OrderType)
export class OrdersResolver {
  constructor(
    private readonly orders: OrdersService,
    private readonly sessions: SessionsService,
  ) {}

  @Query(() => OrderType, { name: 'order' })
  order(@Args('id') id: string): Promise<OrderType> {
    return this.orders.get(id);
  }

  @Mutation(() => Boolean)
  async cancelOrder(@Args('id') id: string): Promise<boolean> {
    await this.orders.cancel(id);
    return true;
  }

  @ResolveField('session', () => String, { nullable: true })
  async session(@Parent() order: OrderType): Promise<string | undefined> {
    return (await this.sessions.find(order.customerId))?.token;
  }
}
