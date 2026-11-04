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
| NestJS | `@Get/@Post/…` in `@Controller` (with controller and `setGlobalPrefix` prefixes), `@EventPattern` / `@MessagePattern`, `@GrpcMethod`, `@Cron` / `@Interval` / `@Timeout`, BullMQ `@Processor` + `process()`, Bull `@Process`, `@OnEvent` | `ClientKafka` / `ClientProxy` `emit` / `send`, `HttpService`, `EventEmitter2.emit` |
| Express | `app.get/post/…`, `router.*` mounted with `app.use('/prefix', router)` (also router factories), `router.route('/x').get()` | responses via `res.json` / `res.send` |
| Fastify | `fastify.get/post/…` (with options), `fastify.route({ method, url, handler })`, plugin `register(…, { prefix })` | responses via `reply.send` |
| KafkaJS | `consumer.run({ eachMessage })`, labelled with the consumer's subscribed topics | `producer.send({ topic })` |
| BullMQ | `new Worker('queue', fn)` | `queue.add()`, queue name from `new Queue('x')` or `@InjectQueue('x')` |
| node-cron | `cron.schedule(expr, fn, { name })` | |
| TypeORM | | `Repository` / `EntityManager` reads and writes; table from `@Entity('x')` |
| Prisma | | `prisma.<model>.<op>()`, `$queryRaw` / `$executeRaw` |
| Mongoose | | `Model` reads and writes; collection from the model name |
| axios, fetch | | HTTP calls; target is the URL's host |

Module discovery is framework-aware too: Nest `@Injectable` providers are modules; controllers, processors,
listeners, `@Module` classes, guards, pipes, interceptors and entities are not. Generated code (Prisma client,
protobuf stubs: files that say "generated" / "do not edit") is never analyzed.

Each adapter is checked against real code by `npm run framework-check --workspace analyzer`:
[sample-nest-service](../sample-nest-service) and [fixtures/frameworks](../fixtures/frameworks) (Express +
Prisma + KafkaJS + node-cron + axios, Fastify + Mongoose + BullMQ + fetch). Every module, entry point and effect
there was listed by hand from the code.

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
- Nest URI versioning (`version: '1'`), GraphQL resolvers, WebSocket gateways and tRPC routers have no adapter yet;
  the profile's `decoratorEntries` / `entryPoints` cover them meanwhile.
