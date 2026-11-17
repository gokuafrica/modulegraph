---
name: module-review
description: Module-level review of a PR, branch/worktree or uncommitted changes. Runs the modulegraph analyzer, which writes the review facts (contract changes, behaviour changes, findings, owners) to a brief file, then adds the human-judgment part and points to the interactive graph. For a service with no profile, writes one OUTSIDE the service repo; never edits the analyzed code. Use when the user asks to review a change "at module level", "as a graph", or asks what a change affects.
---

# Module-level review

Plain Markdown: any coding agent can follow it, not only Claude Code.

Reviewers look at **modules, contracts and flows**, not lines. The analyzer computes the facts. Your job is to
turn them into a short brief and point the reviewer at the 1–3 decisions only a human can make.

**Hard rule: never modify the analyzed code** (no tags, comments, config files or scripts in it). Anything
modulegraph needs about a service lives in its profile, in the modulegraph home on this machine
(`~/.modulegraph/configs/<service>/`), never in the service's repo.

## Where things are

- **modulegraph** is installed at <!-- modulegraph-path -->the root of this repository (the modulegraph checkout)<!-- /modulegraph-path -->.
  Below, `modulegraph` means `node "<that folder>/bin/modulegraph.mjs"`. Run it from anywhere: `--project` is
  the service folder, and defaults to the folder you run it in.
- **Profiles** (one per service): `~/.modulegraph/configs/<package name>/modulegraph.config.json`, plus an optional
  `scenario.ts`. The analyzer prints which profile it used, or the exact path to create when there is none.
- **Reviews**: `~/.modulegraph/reviews/<id>.json` (the graph) and `<id>.brief.md` (the facts), kept until
  `modulegraph done <id>` or `modulegraph clean` removes them (step 3b).
- Templates, framework docs and the schema are in the modulegraph folder: `configs/`, `docs/analyzers.md`,
  `schema/`.
- Not set up yet (`modulegraph is not set up yet`, or no `node_modules`)? Run `npm run setup` in the modulegraph
  folder once.

## 1. Run the analyzer

Pick the mode from what the user said:

| User says | Command |
|---|---|
| "branch X" / "worktree X" | `modulegraph analyze --project <service dir> --head X` |
| "my branch", "this worktree", "the PR I'm fixing" (committed + uncommitted) | `modulegraph analyze --project <service dir inside that checkout>` |
| "my changes", "uncommitted" (only what isn't committed) | `modulegraph analyze --project <service dir inside that worktree> --uncommitted` |
| "PR 123" | `modulegraph analyze --project <service dir> --pr 123` (needs `gh`) |

The base is the repo's default branch (from `origin/HEAD`, else `main` or `master`); add `--base <branch>` when
the change targets another one (a release branch, or the PR it is stacked on).

With `--head`/`--pr`, a branch that is checked out in `--project` with uncommitted edits is read from the working
tree (the brief says "with its uncommitted edits"); `--committed` reads the commit only. For a person reviewing in
the UI, tell them to run `modulegraph review` with the same arguments in their terminal (or run it in the
background yourself): it opens the review in their browser and keeps serving, and the UI's refresh button
re-analyzes only what changed after each edit. It stops by itself after 30 minutes with no requests (an open,
visible review tab keeps it alive). `modulegraph open <id>` shows a saved review without analyzing.

- `<service dir>` is the folder with the service's `package.json`; in a monorepo, the one package that changed
  (run once per changed package).
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

The last lines print two paths: `<id>.json` (for the UI) and **`<id>.brief.md` (the facts: read this one)**.

## 2. Read the facts, then the code behind them

Read `<id>.brief.md` completely. It has the verdict, every change with its **Behaviour inside** lines,
entry-point changes, grouped findings, owners and UI links. Don't read the JSON; it's for the UI.

A change starts at its topmost changed operation. Changed operations reached only through it are its parts
(numbered 1.1, 1.2, …): review them as one change, not as separate ones. A changed operation that other flows
also reach stays its own change, even when a changed caller uses it too.

For each contract change, open the changed functions it lists (`file:line`) and read them. The facts tell you
*what* changed; the code tells you whether it is right. Look especially at:
- every `GUARD CHANGED` and `REMOVED` line: who relied on the old behaviour? (an event no longer emitted for
  some users, a write that became an update and loses history, a check that no longer runs)
- new side effects on read paths, and new writes to tables another module owns
- policy constants and thresholds in new helpers (who decided them?)
- every `gains "<value>"` on an output (a new status, type or state): find the code that branches on that
  field or acts on that entity (cancel, expire, refund, retry paths) and check each handles the new value

### Fill in missing descriptions

If the brief has a **Needs a description** section, the reviewer will meet those operations in the graph with
no explanation. Read each one (and what it calls), then write one or two sentences into the service's profile,
the file the analyzer printed on its `profile:` line (none yet: create it as in step 4), never into the code:

```json
"modules": { "overrides": { "BirthInfoService": { "operations": { "get": "The user's birth info as the document has it and as they told us in KYC, side by side." } } } }
```

Say what it does and when it matters (inputs, outputs, effects, the rule it enforces), not how it does it. Don't
repeat the method name. A doc comment in the code always wins; the UI labels yours "written by the review agent".
Then refresh (or re-run the analyzer).

## 3. Write the brief (≤ 25 lines)

```
**Goal:** one sentence (from the intent), and whether the contract changes match it.
**Verdict:** copy the brief's verdict (BLOCKING with the error rules, or not blocked).
**Changes, riskiest first:** one bullet per change in the brief's "Changes" (not per changed operation):
  Module.op where it begins (reach N): output/effect deltas, then its parts ("inside: X gains …, new Y"),
  and in words every GUARD CHANGED / REMOVED / NEW step from "Behaviour inside" of the root and its parts.
  Don't drop any of those. A change marked "also reached through" another is a shared module: say who else uses it.
**New entry points:** if any.
**Findings:** errors first, grouped by rule with counts (e.g. "fetch-once ×7: …"). Pre-existing: count only.
**Decisions for the human (1–3):** questions only a person can answer, each tied to a specific fact above.
**Request review from:** the owners listed.
**Start here:** the first UI link from the brief.
```

Rules: don't invent effects or entry points that aren't in the facts; if the facts and the code disagree,
say so. Say "no PR description" if the intent is missing.

## 3b. When the review is finished

Reviews are kept until someone removes them: `~/.modulegraph/reviews/<id>.json` holds the service's source code,
`--pr` leaves a `refs/modulegraph/pr-<n>` ref in the reviewed repo, and a review server holds the code in memory.

- **Stop every server you started** (`modulegraph review` or `analyze --serve` run in the background) once you no
  longer need it: `modulegraph stop <id>`. It deletes nothing. If the user is still looking at the review in their
  browser, leave it running and tell them it stops by itself after 30 minutes with no requests.
- **Offer cleanup, don't do it unasked.** When the user says the review is finished (merged, approved, abandoned),
  offer: "`modulegraph done <id>` removes the saved review (graph and brief), its PR ref and leftover temp files;
  `--keep-brief` keeps the brief." Run it only after they say yes. The review page's **✓ done** button does the
  same. Re-running the analyzer re-creates a review at any time.
- Reviews pile up? `modulegraph clean --dry-run` lists reviews older than 14 days (`--older-than <days>`) and
  leftovers in the repos modulegraph has read; show the user the list, and run `modulegraph clean` if they agree.
- These commands only touch modulegraph's own things: files in `~/.modulegraph/`, `refs/modulegraph/*` refs,
  `<repo>/.modulegraph-tmp/<pid>/` folders of runs that are gone and the git worktrees in them. Never delete
  anything else yourself, in the reviewed repo or elsewhere.

## 4. Writing a profile for a new service (read-only on the service)

Write it to `~/.modulegraph/configs/<package name>/modulegraph.config.json` (the analyzer prints this path when
there is none) and set `"service"` to the package name; that's how the analyzer finds it. Never put it in the
service's repo. Templates, in the modulegraph folder: `configs/order-service/` (NestJS: no platform rules, the
adapters cover them) and `configs/identity-profile-service/` (in-house platform classes described by rules).

1. **Run a snapshot first**: `modulegraph analyze --project <dir> --snapshot`. Read the `frameworks:` line and
   the brief's module and entry point counts. Compare them with the code: every route, consumer, queue worker and
   scheduled job should be an entry point; every service with logic should be a module.
2. **Only add rules for what is missing** (in-house platform classes, frameworks without an adapter). Syntax and
   examples: `docs/analyzers.md` in the modulegraph folder, "Teaching it a framework without writing code".
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
6. **Scenario (optional, for example data)**: `scenario.ts` exports `default async (projectRoot, { step }) => …`,
   loads the service from `projectRoot` (dynamic import), and drives realistic calls through its entry points with
   dev data. Wrap each request in `step('<METHOD> <url or what it is>', () => …)`: every module call it makes is
   recorded as one case, which the UI follows through every module. Prefer reusing the service's own seed or
   fixtures over inventing data. NestJS without a container: construct the providers by hand with in-memory
   repositories (see `configs/birth-info-service/scenario.ts` in the modulegraph folder). A scenario runs the
   service's code on this machine: write one only for code you trust, and never point it at real databases or APIs.

Declared contracts (`modules.overrides.<Class>.effects`) are optional. Without them, the base revision is the
contract and `new-side-effect` reports what a change adds.

### Services no backend understands

Today there is a TypeScript backend only (see `docs/analyzers.md` in the modulegraph folder for adding one). For other languages the schema
is still the same: write `modulegraph/v1` JSON yourself:
- Follow `schema/modulegraph.schema.json` in the modulegraph folder; `schema/modulegraph.ts` documents every field.
- Set `generator` to `agent:<model>` so reviewers know it was not statically extracted.
- Only record effects and calls you saw in code. Put anything inferred in `findings` with
  `rule: "agent-uncertain"`, `severity: "info"`.
- Save it as `~/.modulegraph/reviews/<id>.json` and validate it from the modulegraph folder:
  `npm run validate --workspace analyzer -- <file.json>`. `modulegraph open <id>` shows it.
