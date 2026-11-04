---
name: module-review
description: Module-level review of a PR, branch/worktree or uncommitted changes. Runs the modulegraph analyzer, which writes the review facts (contract changes, behaviour changes, findings, owners) to a brief file, then adds the human-judgment part and points to the interactive graph. For a service with no profile, writes one OUTSIDE the service repo; never edits the analyzed code. Use when the user asks to review a change "at module level", "as a graph", or asks what a change affects.
---

# Module-level review

Plain Markdown: any coding agent can follow it, not only Claude Code.

Reviewers look at **modules, contracts and flows**, not lines. The analyzer computes the facts. Your job is to
turn them into a short brief and point the reviewer at the 1–3 decisions only a human can make.

**Hard rule: never modify the analyzed code** (no tags, comments, config files or scripts in it). Anything
modulegraph needs about a service lives in its profile: `configs/<service>/` in the modulegraph repo.

## 1. Run the analyzer (from the modulegraph repo root)

Pick the mode from what the user said:

| User says | Command |
|---|---|
| "branch X" / "worktree X" (committed) | `npm run analyze -- --project <service dir> --head X --base main` |
| "my changes", "uncommitted", a worktree with edits | `npm run analyze -- --project <service dir inside that worktree> --uncommitted` |
| "PR 123" | `npm run analyze -- --project <service dir> --pr 123` (needs `gh`) |

- `<service dir>` is the folder with the service's `package.json` (e.g. `sample-service`, or
  `.worktrees/review-test/sample-service`).
- **Don't pass `--config`, `--intent`, `--title` or `--examples`.** The analyzer finds the profile by package
  name, reads the intent from the PR or the branch's commits, and runs the profile's scenario. Pass `--intent`
  only if the user gave you a description that is not in git.
- Large service (hundreds of entry points)? Add `--lazy`, and `--seed-entries "<entry>,<entry>"` for the 1–2
  flows that matter for this PR.
- The first lines say which backend and frameworks were used, e.g.
  `analyzer: typescript` and `frameworks: NestJS (package.json depends on @nestjs/core), TypeORM (…)`.
  Framework adapters (NestJS, Express, Fastify, KafkaJS, BullMQ, node-cron, TypeORM, Prisma, Mongoose, axios,
  fetch) find entry points and side effects without any profile rules.
- If the output says `profile: none found`, stop and do step 4 first. Never copy another service's profile.
- If it says `analyzer: no static analyzer for <language>`, use "Services no backend understands" below.
- If `npm run` fails for environment reasons, run the same arguments with `node --import tsx analyzer/src/cli.ts`.

The last lines print two paths: `<id>.json` (for the UI) and **`<id>.brief.md` (the facts: read this one)**.

## 2. Read the facts, then the code behind them

Read `<id>.brief.md` completely. It has the verdict, every contract change with its **Behaviour inside**
lines, entry-point changes, grouped findings, owners and UI links. Don't read the JSON; it's for the UI.

For each contract change, open the changed functions it lists (`file:line`) and read them. The facts tell you
*what* changed; the code tells you whether it is right. Look especially at:
- every `GUARD CHANGED` and `REMOVED` line: who relied on the old behaviour? (an event no longer emitted for
  some users, a write that became an update and loses history, a check that no longer runs)
- new side effects on read paths, and new writes to tables another module owns
- policy constants and thresholds in new helpers (who decided them?)
- every `gains "<value>"` on an output (a new status, type or state): find the code that branches on that
  field or acts on that entity (cancel, expire, refund, retry paths) and check each handles the new value

## 3. Write the brief (≤ 25 lines)

```
**Goal:** one sentence (from the intent), and whether the contract changes match it.
**Verdict:** copy the brief's verdict (BLOCKING with the error rules, or not blocked).
**Contract changes, riskiest first:** one bullet each: Module.op (reach N): output/effect deltas, and in
  words every GUARD CHANGED / REMOVED / NEW step from "Behaviour inside". Don't drop any of those.
**New entry points:** if any.
**Findings:** errors first, grouped by rule with counts (e.g. "fetch-once ×7: …"). Pre-existing: count only.
**Decisions for the human (1–3):** questions only a person can answer, each tied to a specific fact above.
**Request review from:** the owners listed.
**Start here:** the first UI link from the brief.
```

Rules: don't invent effects or entry points that aren't in the facts; if the facts and the code disagree,
say so. Say "no PR description" if the intent is missing.

## 4. Writing a profile for a new service (read-only on the service)

Name the folder after the service's `package.json` name and set `"service"` to the same name; that's how the
analyzer finds it. Templates: `configs/order-service/` (NestJS: no platform rules, the adapters cover them) and
`configs/identity-profile-service/` (in-house platform classes described by rules).

1. **Run a snapshot first**: `npm run analyze -- --project <dir> --snapshot`. Read the `frameworks:` line and
   the brief's module and entry point counts. Compare them with the code: every route, consumer, queue worker and
   scheduled job should be an entry point; every service with logic should be a module.
2. **Only add rules for what is missing** (in-house platform classes, frameworks without an adapter). Syntax and
   examples: [docs/analyzers.md](../../../docs/analyzers.md#teaching-it-a-framework-without-writing-code).
   - `entryPoints`: registration calls (class or module + method, which argument is the handler, the label).
   - `decoratorEntries`: decorated handler methods (decorator, the package it comes from, the label).
   - `sinks`: DB, outbox, broker, queue and HTTP client methods, and how to name their target.
   - `responses`: calls whose argument is what a handler answers (`ctx.json(x)`).
3. **Check module discovery** in the same snapshot. Discovery takes classes that take part in constructor
   injection (and framework providers such as Nest `@Injectable`). Fix it with `modules.exclude` (DTOs,
   utilities) and `modules.include` (function-style modules it missed).
4. **Names, owners, summaries**: `modules.overrides.<Class>.name/summary` where the class name is unclear;
   `owners` path globs, relative to the repo root (CODEOWNERS is read automatically if the repo has one).
5. **Rules**: `rules.tableOwners` (table → owning module), `rules.fetchOnce` (expensive fetches that must be
   shared, not repeated). Only add what you saw in the code.
6. **Scenario (optional, for example data)**: `scenario.ts` exports `default async (projectRoot) => …`, loads the
   service from `projectRoot` (dynamic import), and drives realistic calls through its entry points with dev
   data. Prefer reusing the service's own seed or fixtures over inventing data.

Declared contracts (`modules.overrides.<Class>.effects`) are optional. Without them, the base revision is the
contract and `new-side-effect` reports what a change adds.

### Services no backend understands

Today there is a TypeScript backend only (see docs/analyzers.md for adding one). For other languages the schema
is still the same: write `modulegraph/v1` JSON yourself:
- Follow `schema/modulegraph.schema.json`; `schema/modulegraph.ts` documents every field.
- Set `generator` to `agent:<model>` so reviewers know it was not statically extracted.
- Only record effects and calls you saw in code. Put anything inferred in `findings` with
  `rule: "agent-uncertain"`, `severity: "info"`.
- Validate: `npm run validate --workspace analyzer -- <file.json>`. Then add an entry to `ui/public/graphs/index.json`.
