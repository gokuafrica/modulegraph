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
| Swagger (`@nestjs/swagger`) | descriptions: `@ApiOperation({ description \| summary })` describes the entry point and the operation its handler hands the request to; `@ApiProperty({ description })` describes DTO fields | |

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
row makes a GET write). Its steps are marked (`step.pipeline`), and the flow view folds them into one *request
pipeline* node, so a global metrics interceptor doesn't push the business modules aside; a click shows them. The pipeline is part of the entry point: when an item is added or removed, or its code
changes, every entry point behind it is changed, with `access-control-changed` (guards, middleware, metadata; an
error unless a guard or middleware was only added) or `request-pipeline-changed` (interceptors, pipes, filters: a
warning). The brief lists these right under the verdict, and says what guards each new entry point.

### When the analysis is incomplete

Reviews used to be silent when the analyzer couldn't see: a service without `node_modules` resolves no library
call, so it has no side effects, and its review said "not blocked". Now the backend reports, and the graph's
`incomplete` field, the CLI (`ANALYSIS INCOMPLETE`) and the brief's verdict (`INCOMPLETE analysis, not a pass`) say:

- `unresolved-imports`: imported packages that are not installed (or tsconfig path aliases that don't resolve);
- `invariant`: a property every correct review has fails here (an effect whose target is code, an entry point listed
  twice, an HTTP route that is no entry point, a flagged package with no rule): scoped to the operation or entry
  point it is about, shown with ⚠ on its box, not as a review-wide state;
- `unmapped-change`: changed code in a function no operation, entry point or pipeline covers. Composition-root
  wiring (`const x = new Module(…)`) and tests / dev tooling folders (`dev/`, `scripts/`, `seeds/`, `migrations/`,
  `mocks/`, `e2e/`) don't count.
- `missing-entry-points`: signs of handlers the analysis does not see: a message broker client in `package.json`
  (`kafkajs`, or a package built on it) but no consumer entry point; a `Map` or object literal of classes that share
  a method, own or inherited (`ConsumerHandlerMap`: an abstract method of their common base class is preferred,
  e.g. `handleMessages`; a base constructor that registers each instance, `manager.addHandler(this)`, is named);
  abstract base classes whose subclasses register themselves and are in no map; `package.json` scripts that start the
  app with an argument (`nest start -- some-poller`) and the file that reads `process.argv` (an argument that names
  handlers of a map, `nest start -- a-consumer,another`, selects consumers and is not a job). The issue carries the
  `entryRegistries` rule that fixes it.
- `unknown-side-effects`: dependencies whose name says producer, outbox, queue or cloud client (or that are built on
  a broker client), and dependencies that do network I/O themselves or through their own dependencies (an HTTP
  client, `ssh2`, FTP, mail, a database or cache driver, gRPC, a cloud SDK: a vendor's generated REST client on
  `axios`, `ssh2-sftp-client` on `ssh2`), imported by the service for their values, that no adapter or `sinks` rule
  describes. The issue lists the calls into them and carries suggested `sinks`. For a messaging package the target is
  `arg:N.topic` when the argument is an object with a `topic`, else the first string argument, else a message object;
  factories and lifecycle calls (`producer()`, `connect()`, `isHealthy()`) are left out. For a network client every
  call is I/O (`getApplicant()` too) except opening, closing and configuring it (`connect()`, `end()`, `on*()`),
  with the package as the target (`const:<package>`) and kind `http` (a call to another system). Check the kind and
  the target.

A type-only import (`import type`, or a name used only in types) doesn't count, and neither does code outside the
service: tests, dot-folders (`.local/scripts/…`) and a top-level `scripts/` or `tools/`.

Add a name to `coverage.ignore` in the profile to stop a false alarm.

`--check` fails on an incomplete analysis unless `--allow-incomplete`.

### How calls are followed: dispositions, gaps, `--explain`

Every call in an analyzed operation (its private helpers included) gets one disposition: a `step` of the operation,
`inlined` (a project helper whose steps are the operation's), `external` (a library call no adapter or rule makes
I/O), `followed` (a function value or an interface call, resolved to the code it runs) or a `gap` (it can't be
followed). A gap has a reason from a closed list, `function-value`, `interface-dispatch`, `untyped` or `dynamic`, and
is stored on the operation (`operations[].gaps: [{ file, line, reason }]`). The box gets one ⚠ with the line and
reason, and the brief lists gaps under each change ("Not followed"). One gap is enough to show: there is no
threshold.

Steps are placed where they run, not where they are written. A function handed to a call runs:
- in place, once per item, for array methods (`map`, `forEach`, `filter`, …); in place for a promise's `then` /
  `catch` / `finally`, `new Promise(executor)`, and the library calls the adapters or the profile's `callbacks` name
  (NestJS: rxjs operators such as `tap`, `map`, `switchMap`; `catchError` only on error);
- where a project function calls it: directly (`retry(fn)` → `fn()`), or after storing it and calling it later
  (`const ctx = begin(ds, [cb])` … `run(ctx)` → `for (const q of ctx.list) await q(ctx.runner)`): values are followed
  through parameters, return values, objects, arrays, destructuring and closures;
- in another operation that calls the parameter it is given (`locks.withLock(key, async () => …)`), right after
  that call step;
- anywhere else (a library this analysis doesn't know runs it, `setTimeout`, an event emitter): a `function-value`
  gap, and its steps are not shown. Teach a library's rule in the profile:
  `"callbacks": [{ "module": "rxjs", "function": "catchError", "runs": "in-place", "condition": "on error" }]`.

A call on an interface or abstract class goes to every implementation the module wiring provides (`useClass`, and a
`useFactory` that returns its injected instances as a list, with `inject`), as call steps, with a `condition` naming
the implementation when there is more than one. Unbound: an `interface-dispatch` gap.

`analyze --explain` writes `<id>.explain.json` next to the review: for every analyzed operation and entry point,
`[{ file, line, text, disposition, to?, reason? }]`. `modulegraph explain <id> <Class.method>` prints the same for a
person (no operation: the ones with gaps). Attach it to a bug note.

### Transactions

A step is in a transaction when it goes through the transaction's handle, directly or through what it is passed to:
the query runner a transaction is opened on (TypeORM `createQueryRunner()` + `startTransaction()`), what is got from
it (`runner.manager`, a repository from it), the handle a `transaction(cb)` callback is given (`manager`, Prisma's
`tx`), or the handle given to a helper or another operation as an argument. Position doesn't count: a write inside the
callback or between begin and commit that doesn't go through the handle is outside, and the flow notes it ("runs
during …, not through it: a rollback doesn't undo it"). A `@Transactional()` method's steps are all in it.

Transactions open at the same time on different handles commit separately (one can commit and another fail), so
they are never named as one: `2 transactions (legacy, admin), separate commits`, drawn as one box labelled that way.
One handle: `legacy transaction`, named after the data source (`@InjectDataSource('legacy')`, else the field).

### The agent's blind check: `disagreements`

The module-review skill has the agent read the changed code before the diagram and write what it reads differently
into the profile: `"disagreements": { "Class.method": [{ "line": 76, "note": "…" }] }`. modulegraph shows them at the
top of the brief, on `operations[].disagreements` and as the ⚠ on the box. It never changes a step because of them.

### Invariants on every review

Every review checks I1-I5, I7 and I9 of the testers' `invariants.mjs` (acceptance/round-4) on itself
(`analyzer/src/invariants.ts`; I5 in the backend: every HTTP route declared with a framework decorator is an entry
point). A failure is an `invariant` item scoped to its operation or entry point.

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
  "entryRegistries": [   // handlers registered by data
    // handler map + base class: every key of the map is an entry point, handled by its class's `method` (inherited
    // methods count: a handler that inherits handleMessages runs it as its own class, so `this.x()` is its x)
    { "map": "ConsumerHandlerMap", "method": "handleMessages", "kind": "consumer", "label": "kafka consumer {key}" },
    // every concrete subclass of a base class (`{key}` is the class name)
    { "extends": "BaseConsumerHandler", "method": "handleMessages", "kind": "consumer", "label": "consumer {key}" },
    // module picked by a command-line argument: main.ts boots JOBS[argv._[0]], a local `modules[command]`, a dynamic
    // module (`modules[command].register()`, providers from what register() returns) or `case 'x':`; what runs is
    // the module's providers' lifecycle hooks (default onApplicationBootstrap|onModuleInit, and run). One entry point
    // per job, whatever methods run it: the hooks in Nest's order (onModuleInit, then onApplicationBootstrap), and a
    // listed method another listed one calls (`onApplicationBootstrap() { await this.run(); }`) is a step of it
    { "argv": "src/main.ts", "kind": "cron", "label": "job {key}" }
  ],
  "docDecorators": [ { "decorator": "Doc", "from": "@acme/docs", "props": ["description"] } ],   // more description sources
  "coverage": { "ignore": ["@acme/queue-utils"] },
  "frameworks": ["nestjs", "typeorm"]   // optional: replaces detection
}
```

A sink's `arg:N` target is followed back to where the value is made: a local `const`, a `this.x` field set in the
constructor, `config.get('KAFKA_TOPICS').RECORD_CREATED` (shown as the config key, `KAFKA_TOPICS.RECORD_CREATED`), a
parameter (what the service's own callers pass, `a | b`), a message built by a factory (the string the factory is
given: `buildMessage(id, 'OrderShipped')` → `OrderShipped`), an object's `topic` / `type`. A `url:N` target is
followed the same way (a local, a `this.x` field, `request({ url })`) into a template: config keys and parameters in
braces, `${this.config.getOrThrow('PAYMENTS_URL')}/accounts/${id}` → `{PAYMENTS_URL}/accounts/{id}`; an absolute URL
gives its host. A TypeORM `entity` target is the entity class passed (`manager.create(Order, …)`), else the type of
the argument, an entity or an array of them (`manager.save(rows)`).

Profile descriptions (`modules.overrides.<Class>.operations.<method>`) are matched by class name, module id or display
name, in any case; keys that match no class or public method are reported (`profile: … describes nothing`, and a
"Profile descriptions not applied" section in the brief).

`class` is the declaring class, interface or type alias the type checker resolves the call to, or the receiver's own
class when the method is inherited (`KMSClient` for `kmsClient.send()`, declared on the SDK's base `Client`);
`module` is the npm package it comes from (`global` for built-ins). Labels fill `{0}`, `{0.prop}`, `{verb}`, `{path}`, `{class}`,
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

- Effects behind a generic wrapper (`publish(topic, …)`) get what the service's callers pass, joined
  (`a | b`) on the wrapper's own operation; a caller outside the service, or a value computed at runtime, stays
  `<topic from the caller>`.
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
- Transactions are read from handles (see "Transactions"): TypeORM query runners and `transaction(cb)`, Prisma /
  Sequelize / Knex `transaction(cb)` / `$transaction(cb)`, `@Transactional()`. Other clients (a Mongo session) need
  an adapter. A transaction a method's caller opened and passes in (a `queryRunner` parameter) shows in the caller's
  flow, on the call step, not in the method's own flow. Values are followed as far as the code shows them: a
  function stored in a class field and called from another method is a gap. When one call runs functions from a
  list (`for (const q of list) await q(runner)`), each gets every handle in play, so its steps carry the combined
  transaction name.
- Examples from tests: Jest only (config in `package.json` or `jest.config.json/js/cjs`; `jest.config.ts` is not read),
  specs picked by name (`*.spec.*` / `*.test.*` that mention a changed class or its callers, or import their files); e2e
  specs are not run. A branch that isn't checked out runs in a temporary git worktree with links to the checkout's
  `node_modules`; Jest's whole output is kept next to the review as `<id>.tests.log`.
