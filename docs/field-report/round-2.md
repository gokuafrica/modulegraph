# Field report, round 2: R2-1 … R2-10

The re-test of the F1–F8 fixes on the real service ([round 1](README.md)) found nine more problems. Each was first
reproduced on `sample-legacy-nest-service`, grown with the shape the real service has and the sample lacked, then
fixed. Same rules as before: the analyzed code is never changed for modulegraph, and the sample doesn't follow
modulegraph's conventions.

Briefs: [before](round-2/briefs/before-no-profile.brief.md) (round-1 code on the grown sample),
[after, no profile](round-2/briefs/after-no-profile.brief.md), [after, with the suggested rules](round-2/briefs/after-with-rules.brief.md).
Screenshots (headless Edge, `npm run ui-check -- --shots`): the checks panel on the no-profile review
([1440](round-2/after/r2-2-checks-incomplete-1440.png), [1920](round-2/after/r2-2-checks-incomplete-1920.png)); the
worker's inspector with the facade's context ([1440](round-2/after/r2-9-inspector-context-1440.png),
[1920](round-2/after/r2-9-inspector-context-1920.png)); its code-change rows
([1440](round-2/after/r2-6-code-changes-1440.png)); the approve flow ([1920](round-2/after/flow-approve-1920.png)).

| | Status | What the sample has now |
|---|---|---|
| R2-1 examples from tests | **fixed** | standalone install, `glob` 10 next to Babel's `lru-cache` 5 |
| R2-2 "all clear" on INCOMPLETE | **fixed** | (UI) |
| R2-3 handler map, inherited methods | **fixed** | 26 consumers, abstract batch `handleMessages`, 5 inherit it, self-registration |
| R2-4 argv jobs in `main.ts` | **fixed** | your `main.ts`, 7 jobs with `register()` |
| R2-5 targets as code expressions | **fixed** | topics from config / a field / a parameter, a message factory |
| R2-6 function name cut | **fixed** | `conclude-manual-review-decision-service.ts`, `setUserRecordManualData` |
| R2-7 setup misses the branch | **fixed** | one branch list for setup and checks |
| R2-8 false alarms | **fixed** | type-only `@nestjs/microservices` import, `.local/scripts/` |
| R2-9 descriptions one layer down | **fixed** (as suggested: context) | controller → facade → worker |
| R2-10 bogus consumer `topic ?` | **fixed** | (fixtures/frameworks: consumers started in a loop) |

## Your acceptance check (`acceptance/round-2`)

The second version of the report came with its own fixture and check, written on your side. They are in the repo
unchanged ([acceptance/](../../acceptance/README.md)) and run with `npm run accept:r2`.

- **Red first.** On `3b811d5` (a fresh clone of the pushed `main`, `npm run setup`), this Windows machine printed
  exactly your baseline: 9/33, the same lines failing, the four `[setup]` checks green (top-level `lru-cache` 5.1.1,
  nested 10.4.3). Only one number differs: `approve` needs 46 px here, 50 px on your Mac (fonts).
  [red-3b811d5-windows.txt](round-2/red-3b811d5-windows.txt).
- **Green.** On the round-2 code, 33/33 and exit 0, `--ui` and `--fresh-clone` included. Before the push, the
  fresh clone was taken from this local repo; after it, from GitHub. [green.txt](round-2/green.txt). The two
  optional notes resolve too: `publishRaw` gets `KAFKA_TOPICS.MANUAL_REVIEW_AUDIT` through its only caller, and
  the worker's `approve` shows the facade's "Approve user record" as context.
- **No expectation was changed or left failing**: none looked wrong.
- **No fixture names in modulegraph**: `names-check` (first in `npm test`) fails on any of `ConsumerHandlerMap`,
  `handleMessages`, `KAFKA_TOPICS`, `RecordEventsProducer`, `records-review-service`, `SyncFeature`, `.local`, and
  the in-repo sample's names, in `analyzer/src` and `ui/src` (checks excluded), comments included. It failed on 7
  comment lines first (examples taken from the sample); they now use made-up names.
- **Name families, not words.** The handler method is picked by family: `handle*`, then `process*` / `consume*`,
  then `on*` (lifecycle hooks excluded), then `execute` / `run`; within a family a batch method (array
  parameter) wins, and an abstract method of the handlers' common base wins over all. Factories and lifecycle
  calls never become suggested sinks: `producer`, `consumer`, `connect`, `disconnect`, `is*`, `forRoot*`,
  `register*`, `on*`, plus `shutdown`, `destroy`, `configure`, `build`, `new*`, `create{Producer,Consumer,Client,
  Connection,Pool,Admin,Channel,Session,Subscriber}`.

### R2-10 bogus consumer `topic ?`: fixed

- A consumer started where no topic can be read (`kafka.consumer({ groupId })` + `run()` in a loop over registered
  handlers, or `subscribe({ topic: handler.topic })`) used to become an entry point labelled `topic ?` or
  `topic <handler.topic>`. Now it is no entry point. When no consumer was found, the "broker client but no consumer"
  sign says "consumers are created dynamically in `<file>:<line>`"; with other consumers but no registry rule, that
  is a sign of its own. With the profile's registry rule it is covered: 29 consumers, no 30th.
- In the repo: `fixtures/frameworks` got the loop shape (`handler-consumers.ts`); framework-check failed on it first
  (`unexpected entry consumer:topic <handler.topic>`) and now expects the missing-entry-points sign instead.

### Module counts (your "also check")

The brief now says what it counted: `Counted: N modules, M entry points`, and, when the profile has
`entryRegistries`, that their handler classes are counted as entry points, not modules (a run without the rules
counts them as modules). That is the 112 vs 135: the profile, not lazy vs full.


## The sample (commit "sample-legacy-nest-service: the shapes a real service still had")

- **Standalone install**: not a workspace of the repo any more; its own `package-lock.json`, and `npm run setup`
  runs `npm ci` in it. Jest, ts-jest, Babel, TypeORM and `glob` 10 (the specs' fixture loader) share its
  `node_modules`: `node_modules/lru-cache` is 5.1.1 (Babel's), `node_modules/path-scurry/node_modules/lru-cache` is
  10.4.3. npm hoisted `path-scurry` to the top here (you had it under `typeorm/`); the trap is the same: the absolute
  folder first in `moduleDirectories` hands `path-scurry` the top-level `lru-cache` 5. A `.gitignore` of its own.
- **Consumers**: `ConsumerHandlerMap` with 26 entries, `new Map<string, Type<BaseConsumerHandler<any, any>>>([...])`.
  The project's `BaseConsumerHandler` declares `abstract handleMessages(messages: AvroKafkaMessage<T>[])` and no
  `handle()`; its constructor calls `consumersManager.addHandler(this)`. `SyncFeatureBaseHandler` implements
  `handleMessages` and calls `this.syncFeature()`; five handlers extend it and only implement `syncFeature`.
- **Jobs**: `main.ts` is the shape you sent: `minimist`, `const command = args['_'][0]`,
  `if ([...].includes(command))`, a local `modules` object inside `bootstrap()`,
  `NestFactory.create(modules[command].register())`, `app.init()` / `app.close()`, and
  `command?.split(',').map((arg) => ConsumerHandlerMap.get(arg))` for consumers. Seven job modules with
  `static register(): DynamicModule`, the work in `onApplicationBootstrap`. `start:consumers` runs
  `nest start -- user-record-data-updated,user-record-created,…`.
- **Topics and outbox**: `this.configService.get<KafkaTopicsConfig>('KAFKA_TOPICS').RECORD_DUPLICATE_FOUND` into a
  local `topic`, then ``this.producer.send<Schema>({ subject: `${topic}-value`, topic, messages })`` with
  `this.producer = kafkaService.producer({ allowAutoTopicCreation: false })` from the constructor; `this.topic` set in a
  constructor; `publishRaw(parameters)` sending to `parameters.topic`; and
  `createSyncedMessage(guid, record.id, 'UserRecordApprovedNotification')` then
  `outboxService.createOutboxMessage(msg, manager)`. In-house packages: `@acme/nestjs-kafkajs` 3.0.0 (producer
  factory, batch consumers), `@acme/typeorm-outbox-writer` 2.0.0 (`TypeORMOutboxService`).
- **Controller → facade → worker**: `approveUserRecord` (`@ApiOperation`) → `ManualReviewService.approveUserRecord`
  (only hands over) → `ConcludeManualReviewDecisionService.approve` in `conclude-manual-review-decision-service.ts`,
  where the branch changes `approve`, `correctData` and the helper `setUserRecordManualData`.
- **Noise**: `import { RecordMetadata } from '@nestjs/microservices/external/kafka.interface'` used only as a type;
  `.local/scripts/publish-message-local.ts` calling the producer.

The branch `fix/scope-manual-data-to-row` was rebuilt on top of it (same two commits, now in the worker).

## Per item

### R2-1 examples from tests: fixed

Reproduced exactly: `examples: jest Test Suites: 5 failed, 5 total; Tests: 0 total`, brief note `jest failed: Tests: 0
total Snapshots: 0 total …`. With the old config in Jest directly: `TypeError: Class extends value undefined` in
`path-scurry`; with `modulePaths` instead: 14/14.

- The installed folder is now only a `modulePaths` fallback, never first in `moduleDirectories`.
- A worktree gets links (junctions on Windows) to the checkout's `node_modules` folders, project and above, so
  resolution is exactly the checkout's. They are unlinked before the worktree is removed (also by `clean` for a
  killed run), so removing it never reaches into the real `node_modules`.
- A head that is checked out with no edits in the project runs in the checkout itself (your working-tree run went
  to a worktree because the branch was checked out without edits).
- The failure note names the suite and its first error: `src/…spec.ts: Test suite failed to run: TypeError: Class
  extends value undefined is not a constructor or null`. Jest's whole output is written to `<id>.tests.log` next to
  the brief, and the note says where.

Checks: `legacy-review-check` fails on `Tests: 0`; new `standalone-check` copies the sample **outside the repo**
with its own git history and the in-house tarballs next to it, runs `npm ci`, then the CLI with `--head` (worktree)
and with the branch checked out: both must record examples (9 cases from 12 tests each), nothing left behind.

### R2-2 the UI said "all clear" on an incomplete analysis: fixed

The checks button shows the brief's verdict: `◐ incomplete analysis` (dashed, amber), never "all clear" while
`incomplete` is non-empty. The panel starts with an "Analysis incomplete" block: each issue's kind, message and
hint, its signs (folded), and the suggested profile JSON with a copy button and the profile path.
`ui-check` asserts the text, the class and both kinds plus the map rule in the panel.

### R2-3 handler map and inherited methods: fixed

- Detection walks the base classes: the shared method set includes inherited ones, and an abstract method of the
  common base wins (`handleMessages`), then `handleMessages` / `handleMessage` / `handleBatch` / `handle` / ….
  The item names the base and its self-registration: *maps 26 names to classes extending BaseConsumerHandler (which
  registers every instance: `consumersManager.addHandler(this)` in BaseConsumerHandler's constructor) with
  `handleMessages()` (5 of them inherit it)*. Abstract bases that self-register and are in no map get their own
  `{ "extends": … }` suggestion.
- With the rule, **26/26** consumers. The cause of the missing five: the rule index was keyed by method, and the
  five share one inherited method. Each handler class is now its own entry point, and runs as that class: in the
  inherited `handleMessages`, `this.syncFeature()` resolves to the subclass's `syncFeature`
  (`sync-feature-tags` → `TagsService.addTag`, `AuditLogService.record`). A change in one subclass's `syncFeature`
  maps to that consumer only.

### R2-4 argv jobs: fixed

`argvModules` follows `modules[command].register()` to the module (a local object inside `bootstrap()` resolves
like a top-level one), and a module's providers include what its static methods return
(`return { module, imports, providers: [...] }`). **7/7** jobs as `cron` entry points. The consumer path makes no
jobs; a script whose argument names map handlers (`start:consumers`) is not suggested as a job either.

### R2-5 targets as code expressions: fixed

Targets are followed to where the value is made:

| Call | Before | After |
|---|---|---|
| `topic` from `configService.get<…>('KAFKA_TOPICS').RECORD_DUPLICATE_FOUND` | `kafka <topic>` | `kafka KAFKA_TOPICS.RECORD_DUPLICATE_FOUND` |
| `this.topic` set in the constructor | `kafka <this.topic>` | `kafka KAFKA_TOPICS.AUDIT_EVENTS` |
| `parameters.topic` | `kafka <parameters.topic>` | `kafka KAFKA_TOPICS.MANUAL_DATA_REENCRYPTED` (what its caller passes) |
| outbox `msg` from `createSyncedMessage(…, 'UserRecordApprovedNotification')` | `outbox <syncedMessage>` | `outbox UserRecordApprovedNotification` |
| `OutboxEventsService.publish(queryRunner, eventType, …)` (round 1's "not fixed") | `outbox <eventType>` | `outbox user_record.status_changed` |

Suggestions: `AcmeAvroProducer.send` → `"target": "arg:0.topic"` (its argument has a `topic`); `producer()`,
`consumeBatch()`, `disconnect()`, `forRoot()` are left out; `TypeORMOutboxService.createOutboxMessage` is suggested
(`arg:0`, the message the analyzer follows to its factory).

### R2-6 function name cut: fixed

The name never shrinks (`flex: 0 0 auto`, up to the row); the file name takes what's left and ellipsizes, or the file
and counts go to a second line. `ui-check` asserts `scrollWidth <= clientWidth` on every name, at 1440 and 1920.

### R2-7 setup and the sample's branch: fixed

`scripts/demo-branches.json` is the one list: setup creates local branches from it, and the new `branches-check`
(first in `npm test`) fails when a check names a branch the list lacks, or a listed branch is missing ("run
`npm run setup`"). CI on `main` had failed exactly like your run (`Not a valid object name
fix/scope-manual-data-to-row`); `actions/checkout` is a fresh clone every run (only `~/.npm` is cached).

### R2-8 false alarms: fixed

A dependency counts only when the service imports it for its values: `import type`, and named imports used only in
type positions, don't (a constructor parameter's type does: that is injection). Dot-folders and a top-level
`scripts/` / `tools/` are not the service (like tests). `@nestjs/microservices` and `.local/` are gone from the
brief.

### R2-9 descriptions one layer down: fixed as suggested

When a described operation's only step is a call to an undescribed one, that one gets `context` (the facade and its
text). The inspector shows *Called through ManualReview.approveUserRecord: Approves a user record …* tagged
"context, not its own description", above the usual "No description" hint; it stays **Required** in the brief,
with the context and "say what this one adds".

### Agent-written descriptions (from your message, not the report)

A profile description keyed by the name the brief's change headlines show (`ConcludeManualReviewDecision`) instead
of the class name was silently ignored. Now: keys match the class name, module id or display name in any case, and
several keys for one class are merged; a key that matches no class or method is printed (`profile: 1 description
describes nothing … (it has approve, correctData, reject)`) and listed in the brief under **Profile descriptions not
applied**. The brief's JSON lists every required operation with the exact keys, and the skill now tells the agent
to check that the warning and the Required list are gone after it writes them.

## Also fixed on the way

- A repo whose `.gitignore` doesn't list `node_modules` (the copied sample had none) made every installed file an
  untracked change, and the analyzer ran out of memory. Untracked `node_modules` / `.modulegraph-tmp` never count.
- Paths shown in the brief and the UI are shortened to `~/…` also when Windows hands them over as 8.3 short names
  (`C:/Users/ABCDEF~1/…`): those used to show the user's folder name.
- Long module names: the inspector title breaks between the module and the method, a graph node's title between
  CamelCase words, and the change badge stays inside the node.

## Also noticed

- *112 modules (full, with rules) vs 135 (lazy, no profile)*: with the registry rules, handler classes are entry
  points, not modules (22 vs 43 on the sample). The CLI line and the brief now say so when the profile has
  `entryRegistries`.

## Checks

`npm run check` (now also typechecks the standalone sample) and `npm test` pass: branches-check, framework-check
(the sample with and without the rules: 26 consumers, 7 jobs, every target), ui-model-check, legacy-review-check,
standalone-check, lazy-check, lifecycle-check. `npm run ui-check` passes at 1440×900 and 1920×1080.

A fresh clone **outside the modulegraph folder** (`git clone`, `node scripts/setup.mjs --no-skill`, `npm test`):
setup created all six demo branches from `origin/` (`fix/scope-manual-data-to-row` included) and ran `npm ci` in the sample; `npm test` exited 0 (Windows 11, Node 24). CI runs the same on Linux, macOS and Windows on every push.

## Not fixed / known limits

- Query-runner transactions are still not drawn as a transaction box (round 1).
- A parameter whose callers are outside the service (or compute it at runtime) still shows `<topic from the caller>`.
- With the registry rules, consumer handler classes are entry points, so their own specs' examples attach to no
  operation.
