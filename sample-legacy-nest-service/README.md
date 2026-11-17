# user-records-service (demo: a mature in-house NestJS service)

A demo service for modulegraph that is shaped like real production code, **not** like modulegraph's other samples.
It has no profile and no `scenario.ts`: modulegraph has to work, and say what it can't see, from the code alone.

What makes it realistic (each trait comes from a real service modulegraph was run on):

- **A standalone install**, like a real repo: its own `package-lock.json` and `node_modules` (not a workspace of
  the modulegraph repo). Jest, ts-jest, Babel, `glob` 10 (the specs' fixture loader) and TypeORM share that one
  `node_modules`, so the top-level `lru-cache` is 5.x (Babel's) and `path-scurry` (glob's) has its own 10.x nested
  under it. `npm run setup` installs it with `npm ci`.
- NestJS 10 + Express, TypeORM 0.3 with MySQL, Jest, `@nestjs/swagger`, `@nestjs/config`, `prom-client`,
  `minimist`, `class-validator`. CommonJS, a loose `tsconfig` (`strictNullChecks: false`, `noImplicitAny: false`).
- ~20 feature folders (`controllers/`, `services/`, `dto/`, some `entity/`). Almost no JSDoc: controllers document
  themselves with `@ApiOperation` / `@ApiResponse`, DTOs with `@ApiProperty({ description })`. Long kebab-case
  file names (`conclude-manual-review-decision-service.ts`).
- **Controller → facade → worker**: `ManualReviewController.approveUserRecord` (`@ApiOperation`) calls
  `ManualReviewService.approveUserRecord`, which only hands over to `ConcludeManualReviewDecisionService.approve`,
  the class that does the work (no doc comment anywhere).
- **Two named data sources** (`@InjectDataSource('legacy')`, `@InjectDataSource('admin')`); the decision service
  works through `createQueryRunner()` transactions on both, `queryRunner.manager.getRepository(Entity)`, rollback
  in `catch`, release in `finally`. Elsewhere `@InjectRepository(Entity, 'legacy')`.
- In-house packages (in `../packages/`, installed from tarballs like a private registry would ship them):
  `@acme/nestjs-kafkajs` 3 (`KafkaJsService.producer()` returns a producer whose `send({ subject, topic, messages })`
  encodes with Avro; `AvroProducer.send(topic, payload)` from 2.x; depends on `kafkajs`),
  `@acme/typeorm-outbox-writer` 2 (`TypeORMOutboxService.createOutboxMessage(message, manager)`, the older
  `OutboxWriter.write(queryRunner, eventType, payload)`), `@acme/nestjs-logging`.
- Kafka topics come from config (`configService.get<KafkaTopicsConfig>('KAFKA_TOPICS').RECORD_DUPLICATE_FOUND`), from
  a field set in the constructor (`this.topic`) or from a parameter; outbox messages are built by a factory
  (`SyncedMessageService.createSyncedMessage(guid, id, 'UserRecordApprovedNotification')`).
- A global `{ provide: APP_INTERCEPTOR, useClass: RequestTimer }` that calls a large `MetricsService`
  (`prom-client`) on every request, and a middleware that sets up the request context.
- **26 Kafka consumers** in a handler map (`src/consumers/consumer-handler.map.ts`,
  `new Map<string, Type<BaseConsumerHandler<any, any>>>([...])`). The project's own `BaseConsumerHandler` declares
  `abstract handleMessages(messages: AvroKafkaMessage<T>[])` (a batch handler) and its constructor registers the
  instance with `consumersManager.addHandler(this)`. Five feature-sync handlers extend an intermediate
  `SyncFeatureBaseHandler`, which implements `handleMessages`; they only implement `syncFeature`. No
  `@EventPattern`, no `consumer.run` in the service.
- **7 jobs** started from the same `main.ts` with a command-line argument (`minimist`): a local `modules` object
  inside `bootstrap()`, each job module's `static register(): DynamicModule`, `NestFactory.create`, then
  `app.init()` (the work runs in `onApplicationBootstrap`). The same argument, comma-split, selects consumers
  (`npm run start:consumers`).
- A developer script outside the app (`.local/scripts/publish-message-local.ts`) and a type-only import from
  `@nestjs/microservices`.
- Jest specs next to the code (`Test.createTestingModule` with `getDataSourceToken('legacy')` mocks, mocked
  query runners, realistic guids and nested DTOs), `test/e2e/` with supertest, `test/fixtures/` JSON.
- `CODEOWNERS` with two teams on `src/manual-review/`.

## The change under review

Branch `fix/scope-manual-data-to-row` (2 commits):

1. `ConcludeManualReviewDecisionService.setUserRecordManualData` used to copy **one** record's data onto every
   record of the user. Now it reads each row (`findOne`: a new DB read), merges the agent's data into that row's own
   data, normalizes it (`UserRecordDataTransformer.normalize`), encrypts it (`KmsService.encryptString`) and saves
   it. `approve` and `correctData` both use the helper and change with it.
2. `chore: remove comment from setUserRecordManualData`.

Unchanged callers: `PUT /api/v1/internal/manual-review/approve/:guid` and `PUT …/update/:guid` (through the
`ManualReviewService` facade), `EscalationsService.resolve`, and the Kafka handler `UserRecordDataUpdatedHandler`
(consumer `user-record-data-updated`), which modulegraph can only see as an entry point with a profile rule.

```bash
node bin/modulegraph.mjs analyze --project sample-legacy-nest-service --head fix/scope-manual-data-to-row --lazy
# with the profile rules for consumers, jobs, the producer and the outbox:
node bin/modulegraph.mjs analyze --project sample-legacy-nest-service --head fix/scope-manual-data-to-row --lazy --config configs/user-records-service.rules/modulegraph.config.json
```
