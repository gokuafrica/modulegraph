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
}

export interface Tracking {
  carrier: string;
  trackingNo: string;
  status: string;
  eta?: string;
}

/** The carrier's API: shipping rates and live parcel status. */
@Injectable()
export class CarrierClient {
  constructor(private readonly http: HttpService) {}

  async rate(country: string, parcels: number): Promise<number> {
    const res = await firstValueFrom(this.http.get<{ cost: number }>(`https://carrier.example.com/v2/rates?to=${country}&parcels=${parcels}`));
    return res.data.cost;
  }

  async status(trackingNo: string): Promise<{ status: string; eta?: string }> {
    const res = await firstValueFrom(this.http.get<{ status: string; eta?: string }>(`https://carrier.example.com/v2/parcels/${trackingNo}`));
    return res.data;
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

  async tracking(orderId: string): Promise<Tracking | undefined> {
    const shipment = await this.shipments.findOneBy({ orderId });
    if (!shipment) return undefined;
    const live = await this.carrier.status(shipment.trackingNo);
    return { carrier: shipment.carrier, trackingNo: shipment.trackingNo, status: live.status, eta: live.eta };
  }
}
