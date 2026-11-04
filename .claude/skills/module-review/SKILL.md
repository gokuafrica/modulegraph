---
name: module-review
description: Module-level review of a PR, branch/worktree or uncommitted changes. Runs the modulegraph analyzer, opens the interactive graph at the riskiest change, and writes a short reviewer brief. For a service it has not seen, reads the code and writes the service's modulegraph profile (config + scenario) OUTSIDE the service repo; never edits the analyzed code. Use when the user asks to review a change "at module level", "as a graph", or asks what a change affects.
---

# Module-level review

The reviewer looks at **modules, contracts and flows**, not lines. Your job is to get the change into the
graph quickly and point the reviewer at the 1–3 decisions only a human can make. Do not restate the line diff.

**Hard rule: never modify the analyzed repository** (no tags, comments, config files or scripts in it).
Everything modulegraph needs lives in the service's profile: `configs/<service>/` in the modulegraph repo.

## 1. Pick the target

| User says | Mode |
|---|---|
| "PR 123" | `--pr 123` (needs `gh`; uses the PR description as intent) |
| a branch or worktree name | `--head <branch> --base main` |
| "my changes", nothing specific | `--uncommitted` (working tree + untracked vs HEAD) |

## 2. Make sure the service has a profile

Look for `configs/<service>/modulegraph.config.json`. If it is missing, write it (step 5) and come back.

## 3. Analyze and open

From the modulegraph repo root:

```bash
C=configs/<service>
npm run analyze -- --project <path to service> --config $C/modulegraph.config.json <mode flags> \
  --title "<one-line goal>" --intent "<PR description or stated goal>" [--examples $C/scenario.ts]
npm run dev   # http://localhost:5173
```

**Large services: use `--lazy --serve`** instead of analyzing every flow. Read the PR first, then pick the
1–2 entry points a reviewer of *this* change should look at, and pass them:
`--seed-entries "PUT /v1/users/:userId/birth-info/consent,GET /v1/users/:userId/birth-info"` (ids or label
fragments). Without it the analyzer ranks entry points itself: new or changed ones, words from the
title/intent, then distance from the change. The reviewer expands the rest in the UI. Each expansion is saved
back into the JSON.

Always pass `--intent` when you know the goal: the `undisclosed-effect` rule flags side effects the
description doesn't mention (a common sign of agent-added scope). In CI add `--check` (exit 1 on new errors).

## 4. Write the brief (≤ 10 lines)

Read the generated JSON (`ui/public/graphs/<id>.json`): `review.queue`, `review.reviewers`, `findings` where `isNew`.

1. **Goal** in one sentence, and whether the contract changes match it.
2. **Contract changes**, riskiest first: `Module.op: +outbox X, +db.read Y, output +field` with reach (entry points affected).
3. **New findings** (errors first). Pre-existing findings are not this change's problem; give their count only.
4. **Decisions for the human** (1–3): wrong owner for a side effect? Interface widened? Existing module reusable?
5. **Request review from** the owners listed.
6. A deep link to start: `http://localhost:5173/#g=<id>&v=impact&op=<top queue op>&d=1`.

## 5. Writing a profile for a new service (read-only on the service)

Start from `configs/identity-profile-service/` as a template.

1. **Entry points**: find HTTP/gRPC route registrations, Kafka/queue consumers and schedulers. Add each
   framework class + method to `entryPoints` (which argument is the handler, how to label it, whether it is read-only).
2. **Side-effect sinks**: find the DB client or repository base, outbox, Kafka producer, HTTP clients. Add each
   method to `sinks` with the argument index that names the table, topic or service.
3. **Check module discovery**: run `npm run analyze -- --project <dir> --config <file> --snapshot` and look at the
   module list. Discovery takes classes that take part in constructor injection. Fix it with `modules.exclude`
   (DTOs, utilities) and `modules.include` (function-style modules it missed).
4. **Names, owners, summaries**: `modules.overrides.<Class>.name/summary` where the class name is unclear;
   `owners` path globs (CODEOWNERS is read automatically if the repo has one).
5. **Rules**: `rules.tableOwners` (table → owning module), `rules.fetchOnce` (expensive fetches that must be
   shared, not repeated). Only add what you saw in the code.
6. **Scenario (optional, for example data)**: `scenario.ts` exports `default async (projectRoot) => …`, loads the
   service from `projectRoot` (dynamic import), and drives realistic calls through its entry points with dev
   data. Prefer reusing the service's own seed or fixtures over inventing data.

Declared contracts (`modules.overrides.<Class>.effects`) are optional. Without them, the base revision is the
contract and `new-side-effect` reports what a change adds.

### Non-TypeScript services

The schema is language-neutral. Write `modulegraph/v1` JSON yourself:
- Follow `schema/modulegraph.schema.json`; `schema/modulegraph.ts` documents every field.
- Set `generator` to `agent:<model>` so reviewers know it was not statically extracted.
- Only record effects and calls you saw in code. Put anything inferred in `findings` with
  `rule: "agent-uncertain"`, `severity: "info"`.
- Validate: `npm run validate --workspace analyzer -- <file.json>`. Then add an entry to `ui/public/graphs/index.json`.
