# Analyzers: one review pipeline, many backends

modulegraph splits "understanding code" from "reviewing a change":

```
                       ┌────────────── language backends (analyzers/) ──────────────┐
project ─ pickAnalyzer ┤ typescript: ts-morph type checker + framework adapters     │──► Snapshot per revision
                       │ (next: go, java, python…: implement LanguageAnalyzer)      │
                       └────────────────────────────────────────────────────────────┘
Snapshot(base), Snapshot(head) ──► compare ──► rules ──► brief.md + modulegraph/v1 JSON ──► UI
                                     └──── lazy.ts drives the same backends on demand ────┘
```

Everything right of `Snapshot` is language-neutral: contract deltas, step deltas, the review queue, the
guardrail rules, the facts brief, lazy expansion and the UI. A backend only has to say what the modules,
operations, entry points and side effects of one revision are.

## The backend contract

[analyzer/src/analyzers/types.ts](../analyzer/src/analyzers/types.ts):

| Piece | What it is |
|---|---|
| `Snapshot` | modules, operations, entry points and their scopes (steps + data edges), fingerprints, function parts |
| `RevisionAnalysis` | one revision: `run()` for everything; `init` / `listEntryPoints` / `ensureOp` / `ensureEntry` / `callersOf` / `scopesForLines` for lazy analysis |
| `LanguageAnalyzer` | `detect(projectDir)`, `sourceFile(path)` (what to read from git), `frameworks()`, `open({ files })`; optional `reopen(prev, { files })` for the UI's refresh: re-read only changed files and return them (TypeScript keeps the parsed program). Without it, refresh calls `open` again |

Selection: the first backend whose `detect` matches the project, or `--analyzer <id>` / `"analyzer"` in the
profile. With no matching backend the CLI says which language it found (`go.mod`, `pom.xml`, …) and points to
the agent path: an agent writes `modulegraph/v1` JSON directly (see the skill).

A backend that can't do lazy analysis can implement the lazy methods by analyzing everything up front.

## The TypeScript backend and its framework adapters

The TypeScript backend resolves calls with the type checker. What counts as an entry point or a side effect
comes from **framework adapters**, picked from the project's `package.json` (the report and the brief say which,
and why):

| Adapter | Entry points | Side effects |
|---|---|---|
| NestJS | `@Get/@Post/…` in `@Controller` (path from `setGlobalPrefix`, URI versioning: `enableVersioning` + `@Version` / controller `version` / `defaultVersion`, `RouterModule.register` prefixes, controller and method paths), GraphQL `@Query` / `@Mutation` / `@Subscription` / `@ResolveField` in a `@Resolver`, WebSocket `@SubscribeMessage`, `@EventPattern` / `@MessagePattern`, `@GrpcMethod`, `@Cron` / `@Interval` / `@Timeout`, BullMQ `@Processor` + `process()`, Bull `@Process`, `@OnEvent`. Each handler's **request pipeline** (below) | `ClientKafka` / `ClientProxy` `emit` / `send`, `HttpService`, `EventEmitter2.emit`; calls on `@Inject(TOKEN)` / abstract-class dependencies follow the module's `providers` binding |
| NestJS CQRS | | `commandBus.execute(new X())`, `queryBus.execute(…)`, `eventBus.publish(…)` / `publishAll` are steps into the `@CommandHandler(X)` / `@QueryHandler` / `@EventsHandler` class |
| Express | `app.get/post/…`, `router.*` mounted with `app.use('/prefix', router)` (also router factories), `router.route('/x').get()` | responses via `res.json` / `res.send` |
| Fastify | `fastify.get/post/…` (with options), `fastify.route({ method, url, handler })`, plugin `register(…, { prefix })` | responses via `reply.send` |
| KafkaJS | `consumer.run({ eachMessage })`, labelled with the consumer's subscribed topics | `producer.send({ topic })` |
| BullMQ | `new Worker('queue', fn)` | `queue.add()`, queue name from `new Queue('x')` or `@InjectQueue('x')` |
| node-cron | `cron.schedule(expr, fn, { name })` | |
| TypeORM | | `Repository` / `EntityManager` reads and writes; query builders where they run (`getMany` / `getOne` / `getRawMany` … read, `execute()` on an insert / update / delete builder writes); raw `query(sql)` on `DataSource` / `EntityManager` / `QueryRunner`, read or write by the SQL's leading keyword (not a literal: a write to `raw sql`). Table from `@Entity('x')`, the builder's entity, or the SQL |
| Prisma | | `prisma.<model>.<op>()`, `$queryRaw` / `$executeRaw` |
| Mongoose | | `Model` reads and writes; document `save()` / `deleteOne()` / `updateOne()`; collection from the model name |
| axios, fetch | | HTTP calls; target is the URL's host |

Module discovery is framework-aware too: Nest `@Injectable` providers and CQRS handlers are modules; controllers,
resolvers, gateways, processors, listeners, `@Module` classes, guards, pipes, interceptors, entities and abstract
classes (an abstract class is a contract; its implementations are the modules) are not. Generated code (Prisma client,
protobuf stubs: files that say "generated" / "do not edit") is never analyzed.

Each adapter is checked against real code by `npm run framework-check --workspace analyzer`:
[sample-nest-service](../sample-nest-service) and [fixtures/frameworks](../fixtures/frameworks) (Express +
Prisma + KafkaJS + node-cron + axios, Fastify + Mongoose + BullMQ + fetch, and `nest/`: the request pipeline,
CQRS, custom providers, query builders, raw SQL, Mongoose documents, RouterModule, versioning, GraphQL,
WebSockets, two classes with the same name). Every module, entry point, effect, call and pipeline there was
listed by hand from the code. `npm run regression-check --workspace analyzer` edits a git copy of `nest/` the way
PRs do (a guard that stops throwing, `@UseGuards` removed, a query-builder write, a DI rebinding, missing
`node_modules`, …) and checks what the CLI and the brief say, full and lazy.

### NestJS request pipeline

What runs before a handler decides who may call it, and can have side effects of its own. For every handler in a
`@Controller`, `@Resolver` or `@WebSocketGateway`, the entry point lists its pipeline, in Nest's order:

- middleware: `configure(consumer) { consumer.apply(M).exclude(…).forRoutes(Controller | 'path' | { path, method }) }`;
- guards, interceptors, pipes, filters: global (`app.useGlobalGuards(…)` and friends, or `{ provide: APP_GUARD, … }`
  providers), on the controller class, on the method (`@UseGuards(…)`, also inside `applyDecorators`);
- route metadata that guards read: `@SetMetadata(…)`, and the project's own decorators built from it or from
  `Reflector.createDecorator()` (`@Public()`, `@Roles(['admin'])`), as written.

The service's own guard / interceptor / middleware code (`canActivate`, `intercept`, `use`, …) runs ahead of the
handler in the entry point's flow, so its side effects are the entry point's (an interceptor that writes an audit
row makes a GET write). The pipeline is part of the entry point: when an item is added or removed, or its code
changes, every entry point behind it is changed, with `access-control-changed` (guards, middleware, metadata; an
error unless a guard or middleware was only added) or `request-pipeline-changed` (interceptors, pipes, filters: a
warning). The brief lists these right under the verdict, and says what guards each new entry point.

### When the analysis is incomplete

Reviews used to be silent when the analyzer couldn't see: a service without `node_modules` resolves no library
call, so it has no side effects, and its review said "not blocked". Now the backend reports, and the graph's
`incomplete` field, the CLI (`ANALYSIS INCOMPLETE`) and the brief's verdict (`INCOMPLETE analysis, not a pass`) say:

- `unresolved-imports`: imported packages that are not installed (or tsconfig path aliases that don't resolve);
- `unresolved-calls`: many calls on injected dependencies (`this.dep.m()`) resolve to nothing (`any`, untyped);
- `unmapped-change`: changed code in a function no operation, entry point or pipeline covers. Composition-root
  wiring (`const x = new Module(…)`) and tests / dev tooling folders (`dev/`, `scripts/`, `seeds/`, `migrations/`,
  `mocks/`, `e2e/`) don't count.

`--check` fails on an incomplete analysis unless `--allow-incomplete`.

### Teaching it a framework without writing code

Adapters are mostly data, and the same data can go in a service's profile
(`configs/<service>/modulegraph.config.json`), added to whatever the adapters provide:

```jsonc
{
  "entryPoints": [   // registration calls
    { "class": "MessageBus", "method": "on", "kind": "consumer", "label": "topic {0}", "handler": "last" }
  ],
  "decoratorEntries": [   // decorated handlers
    { "decorator": "SqsMessageHandler", "from": "@ssut/nestjs-sqs", "kind": "queue", "label": "queue {0}" }
  ],
  "sinks": [   // side effects; target strategies: arg:N, arg:N.prop, url:N, entity, model, injected, receiver, const:x
    { "class": "EventBus", "method": "publish", "kind": "kafka", "target": "arg:0.topic" },
    { "class": "SqsProducer", "module": "sqs-producer", "method": "send", "kind": "queue", "target": "injected|const:sqs" }
  ],
  "responses": [ { "class": "Context", "method": "json", "arg": 0 } ],
  "frameworks": ["nestjs", "typeorm"]   // optional: replaces detection
}
```

`class` is the declaring class, interface or type alias the type checker resolves the call to; `module` is the
npm package it comes from (`global` for built-ins). Labels fill `{0}`, `{0.prop}`, `{verb}`, `{path}`, `{class}`,
`{method}`, with `{a|b}` fallbacks. Types: `CallMatch`, `SinkRule`, `EntryRule`, `DecoratorEntryRule`,
`ResponseRule` in [config.ts](../analyzer/src/config.ts).

### Adding an adapter in code

When data isn't enough (route prefixes that come from somewhere else, Prisma's `prisma.<model>` shape), write an
adapter: [frameworks/types.ts](../analyzer/src/analyzers/typescript/frameworks/types.ts) has `entryVars`
(extra label variables), `globalVars` and `sink` hooks. Register it in `frameworks/index.ts` and add a case to a
fixture and `framework-check.ts`.

## Adding a language

1. Implement `LanguageAnalyzer` in `analyzer/src/analyzers/<language>/` and add it to `analyzers` in
   `analyzers/index.ts`. The backend can be written in any language: shell out to a Go/Java/Python program that
   prints a `Snapshot` as JSON, and wrap it in `RevisionAnalysis` (lazy methods may analyze everything).
2. Keep ids stable across revisions (`Class.method` for operations, `kind:label` for entry points): comparison
   matches by id.
3. Fill `parts` (the functions behind each scope) and `fingerprints` so code changes and change status work.
4. Add a sample service and a `framework-check`-style test with hand-written expectations.

Until a backend exists, the agent path covers the language: the agent writes `modulegraph/v1` JSON from the code
and marks it `generator: "agent:<model>"`.

## Known limits

- Effects behind a generic wrapper (`publish(topic, …)` called with different topics) get the wrapper's
  parameter as target (`<topic>`), not each caller's topic.
- Relative axios/HttpService URLs name the path (`/v1/charges`); the base URL is configured elsewhere.
- tRPC routers have no adapter yet; the profile's `decoratorEntries` / `entryPoints` cover them meanwhile.
- No adapter yet for the AWS SDK v3 (`client.send(new XCommand(…))`), ioredis / redis, RabbitMQ (amqplib,
  `@golevelup/nestjs-rabbitmq`) or SQS libraries: their calls are side effects only through profile `sinks`.
- Nx and other monorepos: code in `libs/` outside `--project` is not analyzed; imports of it that don't resolve show
  up as `unresolved-imports`.
- Nest pipeline: global enhancers are applied to every controller, resolver and gateway handler (Nest needs
  `inheritAppConfig` for microservices in hybrid apps; showing too much is the safe side). Middleware string routes
  match the path and everything below it. Parameter pipes (`@Param('id', ParseIntPipe)`) are not listed. Library
  guards (`AuthGuard('jwt')` from `@nestjs/passport`) are listed by name; their code is not analyzed.
- Nest DI: bindings decided at runtime (a factory choosing a class from config) and `@Saga()` streams are not
  followed. Request-scoped providers are treated like singletons.
- Two classes with the same name: the first one found (by file order) keeps the plain id (`OrdersService`), the
  others are `OrdersService@<file>`. Adding a class with an existing name in a file that sorts earlier renames the
  existing module's id in that review.
- Raw SQL is classified by its leading keyword; a stored procedure call (`CALL`, `EXEC`) counts as a write.
