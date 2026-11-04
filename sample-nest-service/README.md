# order-service (NestJS demo)

An ordinary NestJS 12 service with no modulegraph markers. Its profile
([configs/order-service](../configs/order-service/modulegraph.config.json)) only names owners and table owners.
Every entry point and side effect below is found by the framework adapters (see [docs/analyzers.md](../docs/analyzers.md)).

| Code | What modulegraph sees |
|---|---|
| `orders/orders.service.ts` `OrdersService` | module: create, get, list, cancel, markPaid, markShipped, expirePending. TypeORM `orders`, Kafka `orders.*`, event `order.*` |
| `pricing/pricing.service.ts` `PricingService`, `TaxClient` | modules: `products` table, HTTP `tax-api.internal` |
| `inventory/inventory.service.ts` `InventoryService` | module: `stock_items` reads/writes |
| `payments/payments.service.ts` `PaymentsService` | module: `payments` table, HTTP `api.payments.example`, queue `receipts` |
| `notifications/notifications.service.ts` `NotificationsService`, `MailClient` | modules: queue `emails`, HTTP `mail.example.com` |
| `orders/orders.controller.ts` | entry points: `GET/POST /api/orders…` (controller prefix + `setGlobalPrefix('api')`), Kafka `@EventPattern('payments.settled' / 'shipments.dispatched')`, gRPC `OrderService/GetOrder` |
| `payments/payments.controller.ts` | entry points: `/api/payments/…`, BullMQ `@Processor('receipts')` |
| `notifications/notifications.service.ts` | entry points: BullMQ `@Processor('emails')`, `@OnEvent('order.created')` |
| `jobs/jobs.ts` | entry points: `@Cron(EVERY_DAY_AT_3AM, { name: 'payments-reconciliation' })`, `@Interval(60_000)` |
| `app.module.ts`, `common/auth.guard.ts`, entities | wiring, guard and data: not modules |

## The demo change

| Branch | What changed |
|---|---|
| `main` | base |
| `feature/order-fraud-hold` | new `FraudService` (risk API) and `fraud/policy.ts`; `OrdersService.create` holds risky orders (`status` gains `"held"`, no stock reservation, `orders.held` instead of `orders.created`); new `POST /api/orders/:id/release`; receipts queued only for succeeded payments. Not in the commit message: `get()` now inserts into `order_views`, so `GET /api/orders/:id` and gRPC `GetOrder` write |

```bash
npm run analyze -- --project sample-nest-service --head feature/order-fraud-hold --base main
npm run live -- orders     # lazy, expandable in the UI
```
