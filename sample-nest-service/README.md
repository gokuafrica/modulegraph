# order-service (NestJS demo)

An ordinary NestJS 12 service with no modulegraph markers. Its profile
([configs/order-service](../configs/order-service/modulegraph.config.json)) only names owners and table owners.
Every entry point and side effect below is found by the framework adapters (see [docs/analyzers.md](../docs/analyzers.md)).

12 modules on `main` (13 on the demo branch), 15 entry points (18), 10 tables. Flows cross several modules, for example:

```
POST /api/orders → Orders.create → Customers.profile          customers
                                 → Pricing.quote → Promotions products, promotions
                                                 → TaxApi     tax-api.internal
                                 → Shipping.rates → CarrierApi carrier.example.com
                                 → Inventory.reserve          stock_items
                                 → orders, order_lines, Pricing.redeem → Promotions (promotion_redemptions)
                                 → kafka orders.created, event order.created
GET /api/orders/:id → Orders.get → orders, order_lines, Customers.profile, Shipping.tracking (when shipped)
```

| Code | What modulegraph sees |
|---|---|
| `orders/orders.service.ts` `OrdersService` | module: preview, create, get, list, cancel, markPaid, markShipped, expirePending. Tables `orders`, `order_lines`; Kafka `orders.*`; event `order.*`. Private `load` / `linesOf` are inlined |
| `customers/customers.service.ts` `CustomersService` | module: `customers` (tier, blocked) |
| `pricing/pricing.service.ts` `PricingService`, `TaxClient` | modules: `products`, HTTP `tax-api.internal` |
| `pricing/promotions.service.ts` `PromotionsService` | module: `promotions`, `promotion_redemptions` |
| `shipping/shipping.service.ts` `ShippingService`, `CarrierClient` | modules: `shipments`, HTTP `carrier.example.com` |
| `inventory/inventory.service.ts` `InventoryService` | module: `stock_items` |
| `payments/payments.service.ts` `PaymentsService` | module: `payments`, HTTP `api.payments.example`, queue `receipts` |
| `notifications/notifications.service.ts` `NotificationsService`, `MailClient` | modules: queue `emails`, HTTP `mail.example.com` |
| `audit/audit.service.ts` `AuditService` | module: `audit_log` |
| `orders/orders.controller.ts` | entry points: `/api/orders…` (controller prefix + `setGlobalPrefix('api')`), Kafka `@EventPattern('payments.settled' / 'shipments.dispatched')`, gRPC `OrderService/GetOrder` |
| `payments/payments.controller.ts` | entry points: `/api/payments/…`, BullMQ `@Processor('receipts')` |
| `notifications/notifications.service.ts` | entry points: BullMQ `@Processor('emails')`, `@OnEvent('order.created')` |
| `jobs/jobs.ts` | entry points: `@Cron(EVERY_DAY_AT_3AM, { name: 'payments-reconciliation' })`, `@Interval(60_000)` |
| `app.module.ts`, `common/auth.guard.ts`, entities | wiring, guard and data: not modules |

## The demo change

Branch `feature/order-fraud-hold`, against `main` (9 files, about +180/−25, 6 modules):

| What | Where it shows |
|---|---|
| New `FraudService.assess`: risk API call, `fraud_checks` insert, `policy.ts` thresholds | added module; reached from `POST /api/orders` and `GET /api/orders/quote` |
| `Orders.create` holds risky orders: `status` gains `"held"`, no stock reservation, `orders.held` instead of `orders.created` / `order.created` | guards changed inside; one `risk.hold?` decision |
| New `POST /api/orders/:id/release` and Kafka `fraud.decisions` (approve → release, reject → cancel) | new entry points |
| Loyalty discount: `Pricing.quote` takes the tier, `Quote` gains `loyaltyDiscount` | signature and output deltas |
| Tracking from `shipments.status` events: `Shipping.tracking` stops calling the carrier, new `updateStatus` consumer | removed http effect (ghost step), removed `CarrierApi.status` |
| Receipts only for succeeded payments | guard changed inside `Payments.handleWebhook` |
| **Not in the commit message**: `get()` inserts into `order_views`; the quote preview now writes `fraud_checks` | `read-path-writes` and `undisclosed-effect` |
| **Left for the reviewer**: rejecting a held order runs `cancel()`, which releases stock that was never reserved; `release` takes the reviewer from the body with no role check | not machine-checked: needs judgment |

```bash
npm run analyze -- --project sample-nest-service --head feature/order-fraud-hold --base main
npm run live -- orders     # lazy, expandable in the UI
```
