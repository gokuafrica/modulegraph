# user-records-service (demo: a mature in-house NestJS service)

A demo service for modulegraph that is shaped like real production code, **not** like modulegraph's other samples.
It has no profile and no `scenario.ts`: modulegraph has to work, and say what it can't see, from the code alone.

What makes it realistic (each trait comes from a real service modulegraph was run on):

- NestJS 10 + Express, TypeORM 0.3 with MySQL, Jest, `@nestjs/swagger`, `@nestjs/config`, `prom-client`,
  `minimist`, `class-validator`. CommonJS, a loose `tsconfig` (`strictNullChecks: false`, `noImplicitAny: false`).
- ~20 feature folders (`controllers/`, `services/`, `dto/`, some `entity/`). Almost no JSDoc: controllers document
  themselves with `@ApiOperation` / `@ApiResponse`, DTOs with `@ApiProperty({ description })`.
- **Two named data sources** (`@InjectDataSource('legacy')`, `@InjectDataSource('admin')`); the manual review
  works through `createQueryRunner()` transactions on both, `queryRunner.manager.getRepository(Entity)`, rollback
  in `catch`, release in `finally`. Elsewhere `@InjectRepository(Entity, 'legacy')`.
- In-house packages (in `../packages/`, installed from tarballs like a private registry would ship them):
  `@acme/nestjs-kafkajs` (`KafkaJsService`, `AvroProducer.send`, `BaseConsumerHandler`; depends on `kafkajs`),
  `@acme/typeorm-outbox-writer` (`OutboxWriter.write(queryRunner, eventType, payload)`), `@acme/nestjs-logging`.
- A global `{ provide: APP_INTERCEPTOR, useClass: RequestTimer }` that calls a large `MetricsService`
  (`prom-client`) on every request, and a middleware that sets up the request context.
- **Kafka consumers** registered in a handler map (`src/consumers/consumer-handler.map.ts`) and dispatched by
  `ConsumersManagerService` by consumer name: no `@EventPattern`, no `consumer.run` in the service.
- **Jobs** started from the same `main.ts` with a command-line argument (`minimist`):
  `npm run start:stale-review-poller` = `nest start -- stale-review-poller`.
- Jest specs next to the code (`Test.createTestingModule` with `getDataSourceToken('legacy')` mocks, mocked
  query runners, realistic guids and nested DTOs), `test/e2e/` with supertest, `test/fixtures/` JSON.
- `CODEOWNERS` with two teams on `src/manual-review/`.

## The change under review

Branch `fix/scope-manual-data-to-row` (2 commits):

1. `ManualReviewService.setUserRecordManualData` used to copy **one** record's data onto every record of the user.
   Now it reads each row (`findOne`: a new DB read), merges the agent's data into that row's own data, normalizes
   it (`UserRecordDataTransformer.normalize`), encrypts it (`KmsService.encryptString`) and saves it.
   `approve` and `updateUserRecordData` both use the helper and change with it.
2. `chore: remove comment from setUserRecordManualData`.

Unchanged callers: `PUT /api/v1/internal/manual-review/approve/:guid`, `PUT …/update/:guid`,
`EscalationsService.resolve`, and the Kafka handler `UserRecordDataUpdatedHandler` (consumer
`user-record-data-updated`), which modulegraph can only see as an entry point with a profile rule.

```bash
node bin/modulegraph.mjs analyze --project sample-legacy-nest-service --head fix/scope-manual-data-to-row --lazy
# with the profile rule for consumers, jobs, the producer and the outbox writer:
node bin/modulegraph.mjs analyze --project sample-legacy-nest-service --head fix/scope-manual-data-to-row --lazy --config configs/user-records-service.rules/modulegraph.config.json
```
