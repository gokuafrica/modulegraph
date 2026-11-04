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
- If the output says `profile: none found`, stop and do step 4 first. Never copy another service's profile.
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

Start from `configs/identity-profile-service/` as a template. Name the folder after the service's
`package.json` name and set `"service"` to the same name; that's how the analyzer finds it.

1. **Entry points**: find HTTP/gRPC route registrations, Kafka/queue consumers and schedulers. Add each
   framework class + method to `entryPoints` (which argument is the handler, how to label it, whether it is read-only).
2. **Side-effect sinks**: find the DB client or repository base, outbox, Kafka producer, HTTP clients. Add each
   method to `sinks` with the argument index that names the table, topic or service.
3. **Check module discovery**: run `npm run analyze -- --project <dir> --snapshot` and look at the
   module list. Discovery takes classes that take part in constructor injection. Fix it with `modules.exclude`
   (DTOs, utilities) and `modules.include` (function-style modules it missed).
4. **Names, owners, summaries**: `modules.overrides.<Class>.name/summary` where the class name is unclear;
   `owners` path globs, relative to the repo root (CODEOWNERS is read automatically if the repo has one).
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
