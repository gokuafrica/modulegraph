# Review conventions: modules up, lines down

How this project turns [research-summary.md](research-summary.md) into practice. Humans review **structure**
(modules, contracts, flows, ownership). Machines review **lines** (types, lint, tests, contract checks).

## The reviewer's loop

1. **Open the review queue** (left panel). Contract changes come first, sorted by risk, then by reach.
   Implementation-only changes rank last. *(R2)*
2. **Zoom out** from the top item: start at the changed module and go up level by level to every API,
   consumer and cron that reaches it. With many entry points they are grouped (`/v1/users/*`, `gRPC`, `cron`),
   and each group shows how many read-only endpoints now write. *(R5)*
3. **Open one flow** that matters (double-click an entry). Check the data path: is shared data fetched once
   and passed down? Does the new side effect belong here?
4. **Drill in** only where the graph says *changes inside*. At a leaf the line diff is there if you need it.
5. **Answer the review questions** in the inspector. They are the decisions a machine can't make. *(R12)*
6. **Guardrails** list what the machine already found. Errors block the merge; you don't re-check them. *(R3, R6, R8)*

## Module contract (what every module declares)

```ts
/**
 * BirthInfo: the user's country and city of birth. Consented data wins; documents are the fallback.
 * @module
 * @owner team-identity
 * @effect db.read birth_info_consents
 * @effect outbox birth_info.source_resolved
 */
export class BirthInfoModule { … }
```

| Contract part | Source | Checked by |
|---|---|---|
| Inputs / outputs | public method signatures (TypeScript types, one level of fields) | output-shape and signature deltas, high/medium risk |
| Direct side effects | `@effect <kind> <target>` | `undeclared-effect` (error), `stale-declaration` (warning) |
| Transitive side effects | computed from calls, never declared | shown as outlined chips and in entry-point totals |
| Owner | `@owner` | owners of changed contracts listed as required reviewers *(R10)* |
| Table ownership | `rules.tableOwners` in `modulegraph.config.json` | `table-ownership` (error) |

Effect kinds: `db.read`, `db.write`, `outbox`, `kafka`, `http`. Not yet modelled from R1: pre/postconditions,
error types, idempotency, cache and file I/O. Add them as tags when a team needs them.

Module = a class with one responsibility that owns its data. Orchestrators (e.g. ProfileAssembler, which
fetches Identity once and fans out) are modules too. Helpers without their own data stay untagged; the
analyzer inlines them, so internals stay hidden until you drill in.

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
| Real effects match declared contract | `undeclared-effect`, `stale-declaration` | error / warning | R3 |
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
| R1 | Module contract schema | Partial: inputs, outputs, typed side effects, owner. Pre/postconditions, errors, idempotency not yet |
| R2 | Contract diffs first | Done: review queue by risk, `changes inside` markers, implementation-only ranked last |
| R3 | Undeclared side effects block merge | Done: `undeclared-effect` + `--check` |
| R4 | Size budget in modules | Done: `review-budget`; stacking itself is up to the team's tooling |
| R5 | Impact view to entry points | Done: zoom-out view, entry grouping, reach counts. Ranking by history not yet |
| R6 | Fitness functions | Done: table ownership, cycles, fetch-once, read-path writes. Red edges in graph not yet (findings link to subjects) |
| R7 | Machine gate | Partial: the module-level gate is here; lint/type/SAST/mutation stay in standard CI |
| R8 | AI risk signals | Partial: CI weakening, undisclosed effects, duplicate reads. Semantic-clone detection not yet |
| R9 | Intent and evidence | Partial: intent vs. actual effects. "Test fails on old behaviour" not yet checked |
| R10 | Route by ownership | Done: reviewers from `@owner`. CODEOWNERS sync and P75 metrics not yet |
| R11 | Graph generated from code | Done: static extraction, contracts live in code, C4-like zoom (flow → module → sub-module → code) |
| R12 | Human attention on design questions | Done: generated review questions per changed contract |
