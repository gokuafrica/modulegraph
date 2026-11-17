# Field report, round 3: R3-1 … R3-7 and the invariants

The re-test of round 2 on the real service passed almost everything; what it still broke came from shapes the round-2
fixture didn't have. This round came with its fixture, its check (72 checks) and **invariants**: properties of any
correct review, with no names in them. All of it is in the repo unchanged
([acceptance/round-3](../../acceptance/README.md)), run with `npm run accept:r3`; the invariants also run over every
sample and fixture of this repo in `npm test`.

| | Status | Also in this repo's own fixture |
|---|---|---|
| R3-1 jobs counted twice | **fixed** | (profile rule on the legacy sample; covered by the invariants) |
| R3-2 HTTP targets not followed | **fixed** | `fixtures/frameworks/nest` `RatesClient`: config key in a field, a local |
| R3-3 network I/O through unknown packages | **fixed** | (needs an installed package: the round-3 fixture only) |
| R3-4 `db.write ?` for entity arrays | **fixed** | `LedgerService.transfer`: `manager.create(Entity, …)` in a `map`, saved at once |
| R3-5 `queryRunner` transactions | **fixed** | `LedgerService.transfer`: two data sources through a helper |
| R3-6 facade that calls a helper first | **fixed** | |
| R3-7 suggested JSON cut off | **fixed** | (UI) |

## Your acceptance check (`acceptance/round-3`)

- **Red first.** On `3275457` (`npm run accept:r3 -- --fresh-clone <GitHub>` before any change), this Windows machine
  printed your baseline line for line: 47/72, the same checks failing.
  [red-3275457-windows.txt](round-3/red-3275457-windows.txt).
- **Green.** GREEN_SUMMARY [green.txt](round-3/green.txt).
- **No expectation was changed or left failing**: none looked wrong.
- **No fixture names in modulegraph**: `names-check` now also fails on `VendorIdentityClient`, `vendorco`,
  `RecordNationalityService`, `RecordMessagesService`, `UserRecordStatusService`, `ReviewerDirectoryService`, the four
  `*_BASE_URL` keys and `captcha-vendor` (25 names). It passed without changes: the fixes use none of them.

## The invariants over this repo (`invariants-check`, in `npm test`)

`analyzer/src/invariants-check.ts` runs your `invariants.mjs` (imported unchanged from `acceptance/round-3`) on the
reviews an agent gets for every sample and fixture: `sample-service` (both demo branches), `sample-nest-service`,
`sample-birth-service`, `sample-legacy-nest-service` (with the repo's rules, and with no profile), `fixtures/frameworks`;
full and lazy. I5 (routes = API entry points) runs on the Nest services, counting the decorators of the reviewed
branch. I6 is added for the service with no profile: the profile its first review suggests, applied as-is, leaves
nothing incomplete. [invariants.txt](round-3/invariants.txt).

They found nothing in the samples that the round-3 fixes didn't already cover; the one failure on the first run was in
the check itself (I5 counted the working tree's routes, not the reviewed branch's).

## What changed, per item

### R3-1 jobs counted twice: fixed

A registered thing (a job, a consumer key) is **one** entry point, whatever methods run it. For each handler class
(or each provider of a job's module) the listed methods are reduced to those the framework calls itself: a listed
method that another listed one reaches through `this.x()` (`onApplicationBootstrap() { await this.run(); }`) is a step
of it, not an entry point. What is left runs in the framework's order (Nest: every `onModuleInit`, then every
`onApplicationBootstrap`), as one flow: the earlier hooks' steps come first, marked with the hook they come from. The
label is `job <name>`, with no method suffix, also when a job module has several providers. `job duplicate-scan` now
has `run()`'s effect, `kafka KAFKA_TOPICS.RECORD_DUPLICATE_FOUND`. Not the fix you warned about: no method is dropped,
two independent hooks are two steps of one job.

### R3-2 HTTP targets: fixed

The URL argument (`url:N`) is followed the way topics already were: a local, a `this.x` field set in the constructor,
`request({ url })` shorthand, string `+`, into a template where config keys and parameters are in braces:
`{LOCKS_SERVICE_BASE_URL}/locks`, `{GEOIP_PROXY_BASE_URL}/ip/{ip}`,
`{ASSESSMENTS_SERVICE_BASE_URL}/v1/internal/entities/{entityId}/assessments/statuses`,
`{VENDOR_WORKFLOW_API_BASE_URL}/v1/oauth2/token`. A URL that comes whole from a parameter is `{url}` (the caller's),
never `?`. On the in-repo sample this also turned `{base}/v2/records/…` (a local's name) into the config key it holds,
`{documentsServiceUrl}/v2/records/…`.

### R3-3 network I/O through unknown packages: fixed

`unknown-side-effects` now also flags a dependency that does network I/O itself or through its own dependencies (read
from its installed `package.json`, as `wraps()` does for brokers): HTTP clients, `ssh2`, FTP, mail, database and cache
drivers, gRPC, cloud SDKs. For such a client every call is I/O (`getApplicant()` too) except opening, closing and
configuring it (`connect`, `end`, `close`, `on*`, `set*`, …; constructors never), so the suggested sinks are
`{ "class": "DefaultApi", "module": "@vendorco/identity-api", "method": "getApplicant", "kind": "http", "target": "const:@vendorco/identity-api" }`
and the like for `createCheck`, `list`, `put`. Kind `http` (a call to another system); `EffectKind` is unchanged. Types
published apart (`@types/ssh2-sftp-client`) now count as the package itself, so the SFTP client's calls are seen. With
the suggested profile, nothing is incomplete (I6) and each of those operations has its named effect.

### R3-4 `db.write ?` for entity arrays: fixed

The TypeORM `entity` target falls back to the argument's type, and for an array to its element type:
`manager.save(entitiesToSave)` (built with `repo.create(…)` in a `map`) is `user_nationalities`,
`manager.save(messages.map((m) => manager.create(RecordMessage, …)))` is `record_messages`.

### R3-5 `queryRunner` transactions: fixed

A transaction opened by hand: in a method that calls `startTransaction()` (directly, or through its own helper:
`Promise.all([this.startTransaction(this.legacyDataSource), this.startTransaction(this.adminDataSource)])`), every
step between the start and the last `commitTransaction()` (or a helper that commits) is in the transaction, steps of
inlined helpers included (`addComment`'s insert). It is one transaction (both are committed together), named after the
data sources it was opened on, followed through the helper's argument to `@InjectDataSource('legacy')`:
`legacy + admin transaction`. The read before and the calls after the commit are outside. The flow draws it as one
transaction box; a publish inside it (`publishDuplicateFound`) gets the UI's existing note, "sent before the commit:
a rollback doesn't undo it".

### R3-6 facade that calls a helper first: fixed

The facade's delegation is its last call whose result it returns, when everything before it only prepares arguments:
steps of its own private helpers, lookups (`get*`, `find*`, `load*`, …), reads. A write or a second real call before it
still means the facade does work of its own. The worker `approve` gets "called by: Approve user record" in the brief
and the inspector.

### R3-7 suggested JSON cut off: fixed

The suggestion's `<pre>` wraps (`white-space: pre-wrap; overflow-wrap: anywhere`) instead of scrolling sideways.
