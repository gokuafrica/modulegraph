/**
 * Checks the framework adapters against small real services: every module, entry point and side effect the
 * analyzer finds must match what a person reading the code finds (written down below, by hand).
 * usage: npm run framework-check --workspace analyzer
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { typescript } from './analyzers/typescript/index.ts';
import { loadConfig } from './config.ts';
import { effectKey } from './effects.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..').replace(/\\/g, '/');

interface Expected {
  project: string;
  frameworks: string[];
  modules: string[];
  /** entry id -> transitive effects */
  entries: Record<string, string[]>;
  /** operation id -> direct effects */
  operations: Record<string, string[]>;
  /** entry id -> type of what the handler answers */
  returns?: Record<string, string>;
  /** operation id -> operations it calls */
  calls?: Record<string, string[]>;
  /** entry id -> its request pipeline, `kind name (scope)` in order */
  pipelines?: Record<string, string[]>;
}

const NEST_ORDERS = 'OrdersService@fixtures/frameworks/nest/src/orders/orders.service.ts';
/** Every route, resolver and gateway goes through the global AuthGuard (APP_GUARD), which reads sessions. */
const GUARDED = 'db.read sessions';
const GLOBAL_PIPELINE = ['guard AuthGuard (global)', 'pipe ValidationPipe (global)', 'filter HttpErrorFilter (global)'];

const cases: Expected[] = [
  {
    project: 'sample-nest-service',
    frameworks: ['nestjs', 'kafkajs', 'bullmq', 'typeorm', 'axios'],
    modules: [
      'OrdersService', 'CustomersService', 'PricingService', 'PromotionsService', 'TaxClient', 'ShippingService', 'CarrierClient',
      'InventoryService', 'PaymentsService', 'NotificationsService', 'MailClient', 'AuditService',
    ],
    entries: {
      'api:POST /api/orders': [
        'db.read customers', 'db.read products', 'db.read promotions', 'http tax-api.internal', 'http carrier.example.com',
        'db.read stock_items', 'db.write stock_items', 'db.write orders', 'db.write order_lines', 'db.write promotion_redemptions',
        'kafka orders.created', 'event order.created',
      ],
      'api:GET /api/orders/quote': ['db.read customers', 'db.read products', 'db.read promotions', 'http tax-api.internal', 'http carrier.example.com'],
      'api:GET /api/orders/:id': ['db.read orders', 'db.read order_lines', 'db.read customers', 'db.read shipments', 'http carrier.example.com'],
      'api:GET /api/orders': ['db.read orders'],
      'api:POST /api/orders/:id/cancel': [
        'db.read orders', 'db.read order_lines', 'db.write orders', 'kafka orders.cancelled', 'http api.payments.example', 'db.write payments',
        'db.write stock_items', 'db.write audit_log',
      ],
      'consumer:topic payments.settled': ['db.write orders', 'db.write audit_log', 'event order.paid'],
      'consumer:topic shipments.dispatched': ['db.write orders', 'db.write shipments'],
      'grpc:gRPC OrderService/GetOrder': ['db.read orders', 'db.read order_lines', 'db.read customers', 'db.read shipments', 'http carrier.example.com'],
      'api:POST /api/payments/webhook': ['db.write payments', 'queue receipts'],
      'api:GET /api/payments/:orderId': ['db.read payments'],
      'queue:queue receipts': ['queue emails'],
      'queue:queue emails': ['http mail.example.com'],
      'event:event order.created': ['queue emails'],
      'cron:cron payments-reconciliation (0 03 * * *)': ['http api.payments.example', 'db.read payments'],
      'cron:cron expireStaleOrders (every 60000 ms)': ['db.read orders', 'db.read order_lines', 'db.write orders', 'db.write stock_items'],
    },
    operations: {
      'OrdersService.create': ['db.write orders', 'db.write order_lines', 'kafka orders.created', 'event order.created'],
      'OrdersService.preview': [],
      // private helpers (load, linesOf) are inlined into the public operation
      'OrdersService.get': ['db.read orders', 'db.read order_lines'],
      'OrdersService.cancel': ['db.read orders', 'db.read order_lines', 'db.write orders', 'kafka orders.cancelled'],
      'CustomersService.profile': ['db.read customers'],
      'PricingService.quote': ['db.read products'],
      'PricingService.redeem': [],
      'PromotionsService.redeem': ['db.write promotion_redemptions'],
      'ShippingService.tracking': ['db.read shipments'],
      'CarrierClient.rate': ['http carrier.example.com'],
      'InventoryService.reserve': ['db.read stock_items', 'db.write stock_items'],
      'PaymentsService.handleWebhook': ['db.write payments', 'queue receipts'],
      'TaxClient.rateFor': ['http tax-api.internal'],
      'AuditService.record': ['db.write audit_log'],
      'NotificationsService.orderConfirmation': ['queue emails'],
    },
    returns: {
      'api:GET /api/orders/:id': 'OrderView', 'grpc:gRPC OrderService/GetOrder': 'OrderView', 'api:GET /api/orders/quote': 'QuotePreview',
    },
  },
  {
    project: 'fixtures/frameworks',
    frameworks: ['express', 'fastify', 'kafkajs', 'bullmq', 'node-cron', 'prisma', 'mongoose', 'axios'],
    modules: ['PaymentGateway', 'InvoiceService', 'SearchIndexer', 'CatalogService'],
    entries: {
      // Express: mounted router from a factory, router.route() chain, wrapped handler, app route
      'api:GET /v1/invoices/:id': ['db.read invoice'],
      'api:POST /v1/invoices': ['db.read customer', 'db.write invoice', 'kafka invoices.issued'],
      'api:POST /v1/invoices/:id/pay': ['db.read invoice', 'db.write invoice', 'http /v1/charges'],
      'api:GET /health': [],
      // KafkaJS consumer.run with topics from consumer.subscribe; node-cron
      'consumer:topic payments.settled': ['db.write invoice'],
      'cron:cron overdue-reminders (0 6 * * *)': ['db.read invoice', 'kafka invoices.reminder'],
      // Fastify: plugin prefix, shorthand with options, route({ method, url, handler }); BullMQ Worker
      'api:GET /v1/products/:sku': ['db.read products'],
      'api:POST /v1/products': ['db.write products', 'queue search-index'],
      'api:GET /v1/products/search': ['http search.example.com'],
      'queue:queue search-index': ['db.read products', 'http search.example.com'],
    },
    operations: {
      'InvoiceService.issue': ['db.read customer', 'db.write invoice', 'kafka invoices.issued'],
      'PaymentGateway.fxRate': ['http fx.example.com'],
      'CatalogService.create': ['db.write products', 'queue search-index'],
      'SearchIndexer.index': ['db.read products', 'http search.example.com'],
    },
    returns: { 'api:GET /v1/invoices/:id': 'Invoice', 'api:GET /health': '{ ok: boolean; }', 'api:POST /v1/products': 'ProductDoc' },
  },
  {
    // NestJS beyond controllers and repositories: request pipeline, CQRS, custom providers, query builders, raw SQL,
    // Mongoose documents, RouterModule, URI versioning, GraphQL, WebSockets, two classes named OrdersService.
    project: 'fixtures/frameworks/nest',
    frameworks: ['nestjs', 'nestjs-cqrs', 'typeorm', 'mongoose'],
    modules: [
      'ReportsService', 'AuditService', 'OrdersService', NEST_ORDERS, 'EmailNotifier', 'SmsNotifier', 'PlaceOrderHandler', 'ListOrdersHandler',
      'OrderPlacedHandler', 'StripeGateway', 'FakeGateway', 'PaymentsService', 'ReviewsService', 'SessionsService',
    ],
    entries: {
      // RouterModule.register([{ path: 'admin', module: AdminModule }]); query builders
      'api:GET /api/admin/reports/daily': [GUARDED, 'db.read orders'],
      'api:POST /api/admin/reports/purge': [GUARDED, 'db.write orders'],
      // the other OrdersService: raw SQL on legacy_orders
      'api:GET /api/legacy/orders/:id': [GUARDED, 'db.read legacy_orders'],
      'api:POST /api/legacy/orders/:id/cancel': [GUARDED, 'db.write legacy_orders'],
      // @Controller({ path: 'orders', version: '1' }), @Version('2'); QueryBus / CommandBus → handlers → EventBus →
      // OrderPlacedHandler → @Inject(NOTIFIER) bound by useFactory: () => new EmailNotifier()
      'api:GET /api/v1/orders': [GUARDED, 'db.read orders'],
      'api:GET /api/v1/orders/:id': [GUARDED, 'db.read orders'],
      'api:GET /api/v2/orders/:id': [GUARDED, 'db.read orders'],
      'api:POST /api/v1/orders': [GUARDED, 'db.write orders', 'http mail.example.com'],
      'api:POST /api/v1/orders/:id/hold': [GUARDED, 'db.write order_holds', 'db.write orders'],
      'api:POST /api/v1/orders/expire': [GUARDED, 'db.write orders', 'db.read orders'],
      // @Inject(PAYMENT_GATEWAY) bound to StripeGateway (FakeGateway implements the interface too)
      'api:POST /api/v1/orders/:id/pay': [GUARDED, 'http api.stripe.example'],
      // @UseInterceptors(AuditInterceptor) writes audit_log on every call; Mongoose document save / deleteOne
      'api:GET /api/reviews': [GUARDED, 'db.write audit_log', 'db.read reviews'],
      'api:POST /api/reviews/:id/approve': [GUARDED, 'db.write audit_log', 'db.read reviews', 'db.write reviews'],
      'api:DELETE /api/reviews/:id': [GUARDED, 'db.write audit_log', 'db.read reviews', 'db.write reviews'],
      'api:GraphQL query order': [GUARDED, 'db.read orders'],
      'api:GraphQL mutation cancelOrder': [GUARDED, 'db.write orders'],
      'api:GraphQL field Order.session': [GUARDED],
      'consumer:ws orders.watch': [GUARDED, 'db.read orders'],
    },
    operations: {
      'ReportsService.daily': ['db.read orders'],
      'ReportsService.purgeCancelled': ['db.write orders'],
      'AuditService.record': ['db.write audit_log'],
      'OrdersService.get': ['db.read legacy_orders'],
      'OrdersService.cancel': ['db.write legacy_orders'],
      [`${NEST_ORDERS}.get`]: ['db.read orders'],
      [`${NEST_ORDERS}.cancel`]: ['db.write orders'],
      [`${NEST_ORDERS}.release`]: ['db.write order_holds'],
      [`${NEST_ORDERS}.resolveHold`]: [],
      [`${NEST_ORDERS}.expireStale`]: ['db.write orders', 'db.read orders'],
      'EmailNotifier.send': ['http mail.example.com'],
      'SmsNotifier.send': ['http sms.example.com'],
      'PlaceOrderHandler.execute': ['db.write orders'],
      'ListOrdersHandler.execute': ['db.read orders'],
      'OrderPlacedHandler.handle': [],
      'StripeGateway.charge': ['http api.stripe.example'],
      'FakeGateway.charge': [],
      'PaymentsService.charge': [],
      'ReviewsService.list': ['db.read reviews'],
      'ReviewsService.approve': ['db.read reviews', 'db.write reviews'],
      'ReviewsService.remove': ['db.read reviews', 'db.write reviews'],
      'SessionsService.find': ['db.read sessions'],
    },
    calls: {
      [`${NEST_ORDERS}.resolveHold`]: [`${NEST_ORDERS}.release`, `${NEST_ORDERS}.cancel`],
      'PlaceOrderHandler.execute': ['OrderPlacedHandler.handle'],
      'OrderPlacedHandler.handle': ['EmailNotifier.send'],
      'PaymentsService.charge': ['StripeGateway.charge'],
    },
    pipelines: {
      // consumer.apply(RequestIdMiddleware).forRoutes(OrdersController, 'reviews')
      'api:GET /api/v1/orders': ['middleware RequestIdMiddleware (global)', 'guard AuthGuard (global)', 'guard RolesGuard (controller)', ...GLOBAL_PIPELINE.slice(1), 'metadata @Public() (method)'],
      'api:POST /api/v1/orders': ['middleware RequestIdMiddleware (global)', 'guard AuthGuard (global)', 'guard RolesGuard (controller)', ...GLOBAL_PIPELINE.slice(1), "metadata @Roles(['clerk']) (method)"],
      'api:GET /api/reviews': ['middleware RequestIdMiddleware (global)', 'guard AuthGuard (global)', 'interceptor AuditInterceptor (controller)', ...GLOBAL_PIPELINE.slice(1)],
      'api:GET /api/admin/reports/daily': [...GLOBAL_PIPELINE, "metadata @Roles(['admin']) (controller)"],
      'api:GET /api/legacy/orders/:id': GLOBAL_PIPELINE,
      'api:GraphQL query order': GLOBAL_PIPELINE,
      'consumer:ws orders.watch': GLOBAL_PIPELINE,
    },
  },
];

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  ✖ ${msg}`);
};
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

for (const c of cases) {
  console.log(`\n${c.project}`);
  const projectDir = join(repo, c.project).replace(/\\/g, '/');
  if (c.project === 'fixtures/frameworks' && !existsSync(join(projectDir, 'generated/prisma/client.ts'))) {
    // The Prisma client is generated code, not committed: generate it once (offline, a few ms).
    const cli = [join(projectDir, 'node_modules/prisma/build/index.js'), join(repo, 'node_modules/prisma/build/index.js')].find(existsSync);
    if (!cli) throw new Error('prisma CLI not installed: run npm install');
    execFileSync(process.execPath, [cli, 'generate'], { cwd: projectDir, stdio: 'ignore' });
  }
  const config = loadConfig(projectDir);
  const detected = typescript.frameworks(projectDir, config).map((f) => f.id);
  if (!same(detected, c.frameworks)) fail(`frameworks ${detected.join(', ')} ≠ ${c.frameworks.join(', ')}`);
  const g = typescript.open({ repo, projectDir, config }).run();
  if (!same(Object.keys(g.modules), c.modules)) fail(`modules ${Object.keys(g.modules).join(', ')} ≠ ${c.modules.join(', ')}`);
  for (const [id, effects] of Object.entries(c.entries)) {
    const e = g.entryPoints[id];
    if (!e) { fail(`entry ${id} not found`); continue; }
    if (!same(e.effects.map(effectKey), effects)) fail(`${id} effects ${e.effects.map(effectKey).join(', ')} ≠ ${effects.join(', ')}`);
  }
  for (const id of Object.keys(g.entryPoints)) if (!c.entries[id]) fail(`unexpected entry ${id}`);
  for (const [id, effects] of Object.entries(c.operations)) {
    const op = g.operations[id];
    if (!op) { fail(`operation ${id} not found`); continue; }
    if (!same(op.directEffects.map(effectKey), effects)) fail(`${id} effects ${op.directEffects.map(effectKey).join(', ')} ≠ ${effects.join(', ')}`);
  }
  for (const [id, calls] of Object.entries(c.calls ?? {})) {
    const got = g.operations[id]?.calls ?? [];
    if (!same(got, calls)) fail(`${id} calls ${got.join(', ')} ≠ ${calls.join(', ')}`);
  }
  for (const [id, pipeline] of Object.entries(c.pipelines ?? {})) {
    const got = (g.entryPoints[id]?.pipeline ?? []).map((p) => `${p.kind} ${p.name} (${p.scope})`);
    if (JSON.stringify(got) !== JSON.stringify(pipeline)) fail(`${id} pipeline ${got.join(', ')} ≠ ${pipeline.join(', ')}`);
  }
  for (const [id, type] of Object.entries(c.returns ?? {})) {
    const got = g.scopes[id]?.returns?.type;
    if (got !== type) fail(`${id} returns ${got} ≠ ${type}`);
  }
  console.log(`  ${Object.keys(g.modules).length} modules, ${Object.keys(g.operations).length} operations, ${Object.keys(g.entryPoints).length} entry points checked`);
}

console.log(failures ? `\n${failures} mismatch(es)` : '\nframework adapters find every module, entry point and side effect');
process.exit(failures ? 1 : 0);
