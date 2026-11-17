# Field report: modulegraph on a real production NestJS service (F1–F8)

> Round 2 (the re-test of these fixes on the real service, R2-1 … R2-10): [round-2.md](round-2.md). Round 3 (R3-1 … R3-7
> and invariants that hold for any review): [round-3.md](round-3.md).

The report came from running modulegraph (v0.4.0, `25785cc`) on a closed-source NestJS service. That code can't be
shared, so a sample with the same shape was built first, every finding was reproduced on it, then fixed and checked
on it, in the browser and in `npm test`.

**The sample:** [`sample-legacy-nest-service/`](../../sample-legacy-nest-service) (package `user-records-service`),
branch `fix/scope-manual-data-to-row` (2 commits). It has no profile and no `scenario.ts`. It is built on NestJS 10,
Express, TypeORM 0.3 with two named MySQL data sources and query-runner transactions. It uses Swagger decorators
instead of JSDoc, a global `APP_INTERCEPTOR` metrics timer over a large `MetricsService` (prom-client), Kafka consumers
in a `ConsumerHandlerMap`, and jobs picked by `minimist(process.argv)`. Its in-house packages (`@acme/nestjs-kafkajs`,
`@acme/typeorm-outbox-writer`, `@acme/nestjs-logging`) are installed from tarballs in [`packages/`](../../packages).
It also has Jest specs with `getDataSourceToken('legacy')` mocks, `test/e2e` with supertest, `test/fixtures`, and a
CODEOWNERS file with two teams. It has 100 files, more than the 40–60 asked for, so that every trait is in it. Its
NestJS 10 / TypeORM 0.3 are installed in its own `node_modules`: the other demos use NestJS 12, which ships as ES
modules only, and the service's Jest config is CommonJS like yours.

## Re-test on your service

```bash
git pull && npm run setup
node bin/modulegraph.mjs analyze --project <service> --head <branch> --lazy      # first run, no profile
node bin/modulegraph.mjs open <id>                                                # live again: refresh, done
node bin/modulegraph.mjs review --project <service> --head <branch>               # live, opens the browser
```

The same run on the sample: `node bin/modulegraph.mjs analyze --project sample-legacy-nest-service --head fix/scope-manual-data-to-row --lazy`.
`npm run ui-check --workspace analyzer` repeats the browser checks below in a headless Edge or Chrome (the one
installed; it is skipped when there is none).

## Changelog, one entry per finding

| | Status | What changed |
|---|---|---|
| **F1** refresh / done missing | **fixed** (the optional settings default was not added) | `modulegraph open <id>` serves a saved review **live** whenever its project folder and refs are still there. It is the same server as `review`: it re-analyzes what was explored in the saved review and keeps its recorded examples. `--static` keeps the old behaviour. In saved mode the top bar says so, with the exact command: `○ saved: run modulegraph open <id> to refresh`. When the static server knows why the review can't be live, it says that too: `○ saved: the branch x is gone`, `opened with --static`. The full `modulegraph review …` command is in the tooltip and in the review (`source.command`). The skill now hands over a live link, never a saved file. A `settings.json` `"serve": true` default was **not** added: `analyze` would then never exit, and agents wait for it to. `review` and `open` cover the case. |
| **F2** no examples on a real service | **fixed** (Jest) | With no scenario, the analyzer runs the service's **own Jest specs that reference the changed classes and their callers**. It finds them by class name, or by an import of their files, including the controller's spec. They run with the service's own Jest and transformer, in the temporary worktree for `--head` / `--pr`, under the same kind of instrumentation as the scenario runner. Each test is a case (`manual-review.service.spec.ts › ManualReviewService approve …`). The UI and the brief say "**from unit tests (mocked dependencies)**". The brief also gives the number of cases and the spec files. A time limit applies (`--tests-timeout`, 120 s by default), and the brief says when it was hit. `--no-tests` turns it off. For `--pr` it is off unless `--tests`, because it would run the PR's code. `scenario.ts` still wins when there is one. On the sample: 4 of the 6 spec files ran, 7 test cases were recorded, and 6 operations got examples (approve, updateUserRecordData, normalize, the Kafka handler, EscalationsService). |
| **F3** descriptions missing | **fixed** | There is a new Swagger adapter, detected from `@nestjs/swagger`. `@ApiOperation({ description \| summary })` describes the entry point, and also the operation its handler hands the request to. `@ApiProperty({ description })` describes DTO fields, for inputs and outputs. When a method has no doc comment, its class's doc comment counts. Ranking: JSDoc > profile > API docs > class comment. The UI names the source ("from @ApiOperation", with the endpoint in the tooltip; "from the class's doc comment"). The brief's **Needs a description** lists only operations with none of these. It marks the changed ones as **required** and gives the exact profile path and JSON. The inspector shows the same hint ("Ask your agent: *Describe X.y in the modulegraph profile*", or the JSON to add). The skill treats it as a required step. `framework-check` covers the Swagger source. |
| **F4** "0 side effects, none changed" | **fixed** | The impact model counts every effect of the grouped operations, direct or through submodules, de-duplicated. It still draws only the changed chips. `ui-model-check` (in `npm test`) checks it on the sample: the Kafka handler reads "3 side effects, none changed", and so does any caller with effects. |
| **F5** Kafka consumers / jobs invisible | **fixed** | With no profile, the review is now **INCOMPLETE**, with two new issue kinds. `missing-entry-points` reports: `kafkajs`, or a package built on it, with 0 consumers; a `Map` or object literal of handler classes that share a method and a base class; `package.json` scripts that start the app with an argument, plus the file that reads `process.argv`. `unknown-side-effects` reports packages named like producer / outbox / queue / cloud client (or built on a broker client) that nothing describes, with the calls into them. Each issue comes with the profile JSON that fixes it, and the skill writes that on a first run. There is a new profile key, `entryRegistries` (below), and `coverage.ignore` silences a false alarm. With the rules: 4 `consumer` and 2 `cron` entry points; `kafka`, `outbox` and `http` (KMS) effects; the handler reaches `updateUserRecordData` (reach 2 instead of 1). |
| **F6** global metrics interceptor takes over flows | **fixed** | Steps that come from the request pipeline (middleware, guards, interceptors) are marked (`step.pipeline`). The flow folds them into one **request pipeline** node, which lists the items, the step count, the modules and the effects, and is marked when the change touches it. "show the steps ▸", or the crumb, unfolds them. Folding also lets the entry point show the example data of the operation it hands over to. The pipeline still counts for access-control / pipeline changes in the brief. |
| **F7** two "risk" labels | **fixed** | The inspector shows **change: medium**: the same value as the Changes bar and the brief, with the reason in the tooltip. Next to it is **contract: low** (what callers see), named as such. The Changes bar tooltip says "change risk". |
| **F8** long names cut off | **fixed** | In code-change rows, a helper of the operation's own class drops the class prefix. The name gets an ellipsis, with the full name and `file:line` on hover. The file and `+/−` stay visible. In the top bar, toggles and buttons never wrap, the review title gives way (ellipsis), the brand's subtitle hides below 1600 px, and the saved-mode message keeps its full command. |

## Found on the sample, not in the report

Each of these is likely on your service too.

1. **Test code leaked into the app's pipeline.** An e2e spec's `app.useGlobalPipes(new ValidationPipe())` was listed
   as a second global pipe of the service, and a test's `setGlobalPrefix` could have set the routes' prefix. Tests
   (`*.spec.*`, `*.test.*`, `test/`, `e2e/`, `__tests__/`) are no longer scanned for wiring, modules or entry points.
   **Fixed.**
2. **Absolute paths in reviews.** An enum-typed output field was written as
   `[import("C:/Users/<name>/…/user-record-status.enum").UserRecordStatusCode.APPROVED | …]`. That leaked the
   machine's folder names into review JSON (and would have leaked them into shipped demo graphs). **Fixed.**
3. **`setGlobalPrefix('api', { exclude: ['metrics', 'health'] })`** was ignored (`/api/health`). **Fixed.**
4. **AWS SDK calls on the changed path were invisible** (`KmsService.encryptString` → `KMSClient.send`). They are now
   reported under `unknown-side-effects` with a suggested sink. Sink rules may name the receiver's class (`KMSClient`)
   when the method is declared on a base class from another package (`@smithy`'s `Client.send`). **Fixed**
   (detection + rule matching; the effect itself needs the profile rule).
5. **CODEOWNERS in the project folder** (a package of a monorepo) was not read. modulegraph now falls back to it,
   with paths relative to that folder. A CODEOWNERS at the repo root, as in your service, already worked. **Fixed.**
6. **Query-runner transactions** (`startTransaction` … `commitTransaction` on two data sources inside `Promise.all`)
   are not drawn as a transaction box. Only `….transaction(cb)` and `@Transactional()` are. **Not fixed**; listed
   under known limits.
7. **An outbox written through an in-house wrapper** (`OutboxEventsService.publish(queryRunner, eventType, …)`) shows
   as `outbox <eventType>`: this is the existing "generic wrapper" limit. **Not fixed.**

## Profile keys for your service (F5)

What the sample's first run suggested, checked against its code and saved as
[`configs/user-records-service.rules/modulegraph.config.json`](../../configs/user-records-service.rules/modulegraph.config.json).
On your machine it goes to `~/.modulegraph/configs/<package name>/modulegraph.config.json`, with
`"service": "<package name>"`:

```json
{
  "service": "user-records-service",
  "entryRegistries": [
    { "map": "ConsumerHandlerMap", "method": "handle", "kind": "consumer", "label": "kafka consumer {key}" },
    { "argv": "src/main.ts", "kind": "cron", "label": "job {key}" }
  ],
  "sinks": [
    { "class": "AvroProducer", "module": "@acme/nestjs-kafkajs", "method": "send", "kind": "kafka", "target": "arg:0" },
    { "class": "KafkaJsService", "module": "@acme/nestjs-kafkajs", "method": "sendMessage", "kind": "kafka", "target": "arg:0" },
    { "class": "OutboxWriter", "module": "@acme/typeorm-outbox-writer", "method": "write", "kind": "outbox", "target": "arg:1" },
    { "class": "KMSClient", "module": "@aws-sdk/client-kms", "method": "send", "kind": "http", "target": "const:aws-kms" }
  ]
}
```

- `entryRegistries[].map`: a top-level `Map` or object literal whose values are handler classes. Each key is an
  entry point (`{key}` in the label), handled by the class's `method`. `extends: "BaseConsumerHandler"` adds
  subclasses that no map lists.
- `entryRegistries[].argv`: the file that boots a different module per command-line argument. It works for a
  registry (`JOBS[argv._[0]]`, `.get(...)`) and for `case 'x':` / `if (arg === 'x')` around
  `NestFactory.createApplicationContext(XModule)`. What runs is the module's providers' `onApplicationBootstrap` /
  `onModuleInit` / `run` (or `method`).
- `coverage.ignore`: package, script or map names that the "probably missing" checks should not flag.
- Your real names differ: take them from your own first run's brief, which prints these rules with your service's
  names.

## Before / after

Screenshots are at 1440×900 (before) and at 1440×900 / 1920×1080 (after), taken in a headless Edge.

| | Before | After |
|---|---|---|
| F1 | [before/f1-saved-no-buttons.png](before/f1-saved-no-buttons.png) | [after/f1-live-topbar.png](after/f1-live-topbar.png), [after/f1-saved-after-stop.png](after/f1-saved-after-stop.png), [after/f1-saved-static-reload.png](after/f1-saved-static-reload.png), [after/f1-refresh-prompt.png](after/f1-refresh-prompt.png) |
| F4 | [before/f4-impact-0-side-effects.png](before/f4-impact-0-side-effects.png) | [after/f4-impact-3-side-effects.png](after/f4-impact-3-side-effects.png) |
| F6 | [before/f6-flow-metrics.png](before/f6-flow-metrics.png) | [after/f6-flow-folded-pipeline.png](after/f6-flow-folded-pipeline.png), [after/f6-flow-1920.png](after/f6-flow-1920.png) |
| F7, F8, F2, F3 | [before/f7-f8-inspector.png](before/f7-f8-inspector.png) | [after/f7-f8-inspector.png](after/f7-f8-inspector.png), [after/f8-code-changes.png](after/f8-code-changes.png), [after/f2-f3-inspector-1920.png](after/f2-f3-inspector-1920.png) |
| drill-in | [before/drill-in.png](before/drill-in.png) | [after/drill-in.png](after/drill-in.png) |

Briefs (F2, F3, F5): [before](briefs/before.brief.md) · [after, no profile](briefs/after-no-profile.brief.md) ·
[after, with the profile rules](briefs/after-with-rules.brief.md).

## Checks

- `npm test` now also runs `ui-model-check` (F4, F6, on the sample's branch) and `legacy-review-check`. The second
  runs the CLI on the sample with no profile and checks the brief: examples from tests, INCOMPLETE with the rules,
  descriptions, owners, and nothing left in the repo. `framework-check` has the sample twice (no profile; with the
  rules) and checks hand-written modules, entry points, effects, pipelines, description sources, DTO field docs and
  the "probably missing" issues. `lazy-check` checks lazy == full (and refresh == full) on it, with and without the
  profile.
- `npm run ui-check --workspace analyzer`: the browser checks of section 4 of the report, at 1440×900 and 1920×1080.
  It covers `analyze` → `open` live, the top bar on one line, impact counts, the folded pipeline, the inspector,
  drill-in, the saved message after the server stops and after a `--static` reload, and edit → refresh prompt →
  refresh.
