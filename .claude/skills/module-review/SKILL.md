---
name: module-review
description: Module-level review of a PR, branch/worktree or uncommitted changes. Runs the modulegraph analyzer, opens the interactive graph at the riskiest change, and writes a short reviewer brief. For codebases without module conventions, groups code into modules (inputs, outputs, side effects) and emits modulegraph/v1 JSON the UI reads. Use when the user asks to review a change "at module level", "as a graph", or asks what a change affects.
---

# Module-level review

The reviewer looks at **modules, contracts and flows**, not lines. Your job is to get the change into the
graph quickly and point the reviewer at the 1–3 decisions only a human can make. Do not restate the line diff.

## 1. Pick the target

| User says | Mode |
|---|---|
| "PR 123" | `--pr 123` (needs `gh`; uses the PR description as intent) |
| a branch or worktree name | `--head <branch> --base main` |
| "my changes", nothing specific | `--uncommitted` (working tree + untracked vs HEAD) |

## 2. Check the codebase declares modules

Search for `@module` JSDoc tags in the service (`Grep "@module"`).
- **Found** → go to step 3.
- **Not found** → do step 5 first (extraction), then come back.

## 3. Analyze and open

From the repo root:

```bash
npm run analyze -- --project <service-dir> <mode flags> --title "<one-line goal>" --intent "<PR description or stated goal>"
npm run dev   # http://localhost:5173
```

Always pass `--intent` when you know the goal: the `undisclosed-effect` rule flags side effects the
description doesn't mention (a common sign of agent-added scope). In CI use `--check` (exit 1 on new errors).

## 4. Write the brief (≤ 10 lines)

Read the generated JSON (`ui/public/graphs/<id>.json`): `review.queue`, `review.reviewers`, `findings` where `isNew`.

1. **Goal** in one sentence, and whether the contract changes match it.
2. **Contract changes**, riskiest first: `Module.op: +outbox X, +db.read Y, output +field` with reach (entry points affected).
3. **New guardrail findings** (errors first). Pre-existing findings are not this change's problem; mention their count only.
4. **Decisions for the human** (1–3): wrong owner for a side effect? Interface widened? Existing module reusable?
5. **Request review from** the owners listed.
6. A deep link to start: `http://localhost:5173/#g=<id>&v=impact&op=<top queue op>&d=1`.

## 5. Extraction for codebases without conventions

Goal: every module has a declared contract the analyzer can check (an "architecturally evident" codebase).

1. **Find entry points**: HTTP/gRPC route registrations, Kafka/queue consumers, schedulers. Note the
   framework classes and methods; add them to `entryPoints` in `<service>/modulegraph.config.json`.
2. **Find side-effect sinks**: the DB client/repository base, outbox, Kafka producer, HTTP clients. Add each
   method to `sinks` with the argument index that names the table/topic/service. If the table is not an
   argument (ORM repositories), tag the repository class as a module and declare its tables with `@effect`.
3. **Group code into modules**: one class per responsibility that owns its data. Signals: a constructor that
   injects collaborators, a cohesive set of public methods, its own tables. Orchestrators (fetch once, fan out)
   are modules too. Helpers without their own data stay untagged; the analyzer inlines them into the caller.
4. **Tag each module class**:
   ```ts
   /**
    * BirthInfo: the user's country and city of birth. Consented data wins; documents are the fallback.
    * @module
    * @owner team-identity
    * @effect db.read birth_info_consents
    * @effect outbox birth_info.source_resolved
    */
   ```
   `@effect` lists the module's **direct** effects (kinds: `db.read`, `db.write`, `outbox`, `kafka`, `http`).
   Effects of called modules are computed, never re-declared.
5. Propose the tags as their **own PR** (no behaviour change), so later reviews diff contracts.
6. Run `npm run analyze -- --project <dir> --snapshot` and fix `undeclared-effect` / `stale-declaration` findings.

### Non-TypeScript services

The schema is language-neutral. Write `modulegraph/v1` JSON yourself:
- Follow `schema/modulegraph.schema.json`; `schema/modulegraph.ts` documents every field.
- Set `generator` to `agent:<model>` so reviewers know it was not statically extracted.
- Only record effects and calls you saw in code. Put anything inferred in `findings` with
  `rule: "agent-uncertain"`, `severity: "info"`.
- Validate: `npm run validate --workspace analyzer -- <file.json>`. Then add an entry to `ui/public/graphs/index.json`.
