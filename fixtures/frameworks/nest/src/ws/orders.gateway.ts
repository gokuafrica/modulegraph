import { MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { OrdersService } from '../orders/orders.service.ts';

@WebSocketGateway({ namespace: 'orders' })
export class OrdersGateway {
  constructor(private readonly orders: OrdersService) {}

  @SubscribeMessage('orders.watch')
  watch(@MessageBody() id: string): Promise<unknown> {
    return this.orders.get(id);
  }
}
