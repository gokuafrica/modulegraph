import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Column, Entity, PrimaryColumn, Repository } from 'typeorm';
import type { OrderLine } from '../orders/order.entity.ts';

@Entity('shipments')
export class Shipment {
  @PrimaryColumn()
  orderId: string;

  @Column()
  carrier: string;

  @Column()
  trackingNo: string;

  @Column()
  dispatchedAt: Date;

  @Column({ default: 'dispatched' })
  status: string;

  @Column({ nullable: true })
  eta?: string;
}

/** The carrier's status webhook, relayed by the logistics team on `shipments.status`. */
export interface CarrierStatusEvent {
  trackingNo: string;
  status: string;
  eta?: string;
}

export interface Tracking {
  carrier: string;
  trackingNo: string;
  status: string;
  eta?: string;
}

/** The carrier's API: shipping rates. Parcel status arrives as events (see ShippingService.updateStatus). */
@Injectable()
export class CarrierClient {
  constructor(private readonly http: HttpService) {}

  async rate(country: string, parcels: number): Promise<number> {
    const res = await firstValueFrom(this.http.get<{ cost: number }>(`https://carrier.example.com/v2/rates?to=${country}&parcels=${parcels}`));
    return res.data.cost;
  }

}

/** Shipping: what delivery costs, and where a dispatched order is. Owns the shipments table. */
@Injectable()
export class ShippingService {
  constructor(
    @InjectRepository(Shipment) private readonly shipments: Repository<Shipment>,
    private readonly carrier: CarrierClient,
  ) {}

  async rates(country: string, lines: OrderLine[]): Promise<number> {
    const parcels = Math.ceil(lines.reduce((n, l) => n + l.quantity, 0) / 5);
    return this.carrier.rate(country, parcels);
  }

  async recordDispatch(orderId: string, carrier: string, trackingNo: string): Promise<void> {
    await this.shipments.save({ orderId, carrier, trackingNo, dispatchedAt: new Date() });
  }

  async updateStatus(event: CarrierStatusEvent): Promise<void> {
    await this.shipments.update({ trackingNo: event.trackingNo }, { status: event.status, eta: event.eta });
  }

  async tracking(orderId: string): Promise<Tracking | undefined> {
    const shipment = await this.shipments.findOneBy({ orderId });
    if (!shipment) return undefined;
    return { carrier: shipment.carrier, trackingNo: shipment.trackingNo, status: shipment.status, eta: shipment.eta };
  }
}
