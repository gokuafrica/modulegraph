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
}

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
  for (const [id, type] of Object.entries(c.returns ?? {})) {
    const got = g.scopes[id]?.returns?.type;
    if (got !== type) fail(`${id} returns ${got} ≠ ${type}`);
  }
  console.log(`  ${Object.keys(g.modules).length} modules, ${Object.keys(g.operations).length} operations, ${Object.keys(g.entryPoints).length} entry points checked`);
}

console.log(failures ? `\n${failures} mismatch(es)` : '\nframework adapters find every module, entry point and side effect');
process.exit(failures ? 1 : 0);
