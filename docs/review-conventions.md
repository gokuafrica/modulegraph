# Review conventions: modules up, lines down

How this project turns [research-summary.md](research-summary.md) into practice. Humans review **structure**
(modules, contracts, flows, ownership). Machines review **lines** (types, lint, tests, contract checks).

## The reviewer's loop

1. **Start here**: the *Changes* bar above the graph. Contract changes come first, sorted by risk, then by reach.
   Implementation-only changes rank last. A chip is always one click back to its change, and the path under the
   bar shows every view between it and where you are. *(R2)*
2. **Impact view** (*zoom out*) from the top item: start at the changed module and go up level by level to every API,
   consumer and cron that reaches it. With many entry points they are grouped (`/v1/users/*`, `gRPC`, `cron`),
   and each group shows how many read-only endpoints now write. *(R5)*
3. **Open one flow** that matters (double-click an entry). Check the data path: is shared data fetched once
   and passed down? Does the new side effect belong here?
4. **Drill in** only where the graph says *changes inside*. Follow one example request: the input, each module's
   `in` / `out` line and the response all belong to the same recorded request, and it stays selected as you drill
   in, so the data you saw at the API is the data you see three modules down (expand nested values like in the
   devtools). Inside a changed flow, outlined
   steps are new calls, red ghosts are calls the change removed, and purple labels mark changed guards.
5. **Read code last, function by function**. *code changes ±* lists every changed function behind the
   operation, including inlined helpers in other files, with +/− counts, before showing any code. Start with the
   operation's own method, which holds the contract-relevant logic, then the helpers. Unchanged lines are folded and
   edited words are marked. A helper that is only newly called, with no code change, is not listed: it shows up
   as a new step instead.
6. **On a large service, let the graph grow with you** (`--lazy`). Start from the 1–2 flows picked for the
   PR and load more callers or flows only when a question needs them. Each loaded part is checked as exactly as
   in a full analysis (`npm run lazy-check --workspace analyzer`).
7. **Checks** list what the machine already found. Errors block the merge; you don't re-check them. *(R3, R6, R8)*

## Module contract (derived, never written into the code)

The analyzed code is not modified. A contract is assembled from the code plus the service's external profile
(`configs/<service>/modulegraph.config.json`).

| Contract part | Source | Checked by |
|---|---|---|
| Module boundary | structure: classes taking part in constructor injection; profile `modules.include/exclude` | n/a |
| Inputs / outputs | public method signatures (TypeScript types, one level of fields) | output-shape and signature deltas, high/medium risk |
| Example data | recorded by running the profile's `scenario.ts` against the head revision | shown on flow ends and in the contract card |
| Direct side effects | calls to the profile's `sinks` (DB, outbox, Kafka, HTTP), with the table/topic/service | `new-side-effect` (vs. base); `undeclared-effect` where the profile declares a contract |
| Transitive side effects | computed from calls | shown as outlined chips and in entry-point totals |
| Owner | profile `owners` globs, else the repo's CODEOWNERS | owners of changed contracts listed as required reviewers *(R10)* |
| Table ownership | profile `rules.tableOwners` | `table-ownership` (error) |

**The base revision is the contract.** Nobody has to maintain declarations: whatever a module did on `main` is
its contract, and a change that adds a side effect is reported as `new-side-effect`. Teams that want a stricter,
reviewed contract can list effects per module in the profile (`modules.overrides.<Class>.effects`); then
`undeclared-effect` fails CI on any mismatch.

Effect kinds: `db.read`, `db.write`, `outbox`, `kafka`, `http`. Not yet modelled from R1: pre/postconditions,
error types, idempotency, cache and file I/O.

A module is a class with one responsibility that owns its data. Orchestrators (e.g. ProfileAssembler, which
fetches Identity once and fans out) are modules too. Helpers outside dependency injection are inlined into their
caller, so internals stay hidden until you drill in.

## PR rules

| Rule | Default | Why | Enforced |
|---|---|---|---|
| One stated goal + expected contract changes in the description | required | Lets the tool diff intent against reality *(R9)* | `undisclosed-effect` when `--intent`/PR body is given |
| Review budget | ≤ 5 contract changes, ≤ 400 changed lines, < 20 files | Defect discovery and comment usefulness fall beyond these sizes (SmartBear; Microsoft 2015) *(R4)* | `review-budget` (warning: split into a stack) |
| Stacks | one contract change per PR where possible | Google median change is 24 lines; small changes get faster, better reviews | reviewer judgement + budget |
| Contract tags in their own PR | when adopting the tool | keeps behaviour diffs readable | convention |

## Machine gate (before a human looks)

| Guardrail | Rule id | Severity | Recommendation |
|---|---|---|---|
| Side effect added by the change (base = contract) | `new-side-effect` | warning (writes) / info (reads) | R3 |
| Real effects match a declared contract (if the profile declares one) | `undeclared-effect`, `stale-declaration` | error / warning | R3 |
| Only the owner writes a table | `table-ownership` | error | R6 |
| No module dependency cycles | `module-cycle` | error | R6 |
| Shared expensive fetch happens once per flow (Identity) | `fetch-once` | error | R6 |
| Read-only endpoints (GET, gRPC Get*) don't write | `read-path-writes` | warning | R5/R6 |
| Same read twice in one operation | `duplicate-read` | warning | R8 |
| Tests deleted/skipped, `@ts-ignore`, `eslint-disable`, `\|\| true`, `as any` | `guardrail-weakened` | error / warning | R8 (CI weakening is a hard stop) |
| Changes outside any module | `unattributed-change` | info | R2 |
| Oversized change | `review-budget` | warning | R4 |

`modulegraph --check` exits non-zero only for **new** error-level findings. Pre-existing ones are shown
separately, so teams can adopt the tool on a legacy codebase and ratchet down. Typecheck, lint, unit tests and
SAST stay in their usual CI jobs. Keep any checker below ~10% effective false positives, or demote it (Google).

## Recommendation coverage

| | Recommendation | Status in the MVP |
|---|---|---|
| R1 | Module contract schema | Partial: inputs, outputs, example data, typed side effects, owner, all derived without code changes. Pre/postconditions, errors, idempotency not yet |
| R2 | Contract diffs first | Done: one item per independent change (changed operations reached only through another changed one are its parts), riskiest first; `changes inside` markers; implementation-only ranked last |
| R3 | Undeclared side effects block merge | Done: `new-side-effect` against the base by default; `undeclared-effect` + `--check` when the profile declares a contract |
| R4 | Size budget in modules | Done: `review-budget`; stacking itself is up to the team's tooling |
| R5 | Impact view to entry points | Done: zoom-out view, entry grouping, reach counts. Ranking by history not yet |
| R6 | Fitness functions | Done: table ownership, cycles, fetch-once, read-path writes. Red edges in graph not yet (findings link to subjects) |
| R7 | Machine gate | Partial: the module-level gate is here; lint/type/SAST/mutation stay in standard CI |
| R8 | AI risk signals | Partial: CI weakening, undisclosed effects, duplicate reads. Semantic-clone detection not yet |
| R9 | Intent and evidence | Partial: intent vs. actual effects. "Test fails on old behaviour" not yet checked |
| R10 | Route by ownership | Done: reviewers from the profile's `owners` globs or the repo's CODEOWNERS. P75 metrics not yet |
| R11 | Graph generated from code | Done: static extraction with zero code changes, C4-like zoom (flow → module → sub-module → code) |
| R12 | Human attention on design questions | Partial: the UI shows only contracts, flows and checks. Templated review questions were removed as noise |
