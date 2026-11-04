# Can a small, zero-context agent review with modulegraph?

Test of 2026-11-04. Claude Haiku got only a one-line request ("review X at module level, follow
`.claude/skills/module-review/SKILL.md`") and no other context. Its briefs were graded against a checklist written
**before** the runs ([ground-truth.md](ground-truth.md)).

| Test | What | Why it's hard |
|---|---|---|
| A | branch `feature/kyc-risk-tiers` vs `main` | multi-file change; the risky parts are behaviour changes inside a flow (an event no longer sent, insert→update), not new effects |
| B | uncommitted changes in a worktree ([patch](test-b-uncommitted.patch)) | unseen change, no existing graph to copy; planted errors: fetch-once, table ownership, writes on read paths |

## Results

| Round | Test A: critical / important | Test B: critical / important | Process problems |
|---|---|---|---|
| 1: original skill | 3 of 5 / 4 of 4. Missed `kyc.completed` no longer sent for reviewed users; history loss only in passing | 4 of 4 / 3 of 4 (missed new output field, didn't call it blocking) | `npm run analyze` failed for both; A missed the existing profile and created a duplicate |
| 2: facts brief, auto profile and intent | 4.5 of 5 / 4 of 4. Caught the guard change; added the Onboarding impact itself | **4 of 4 / 4 of 4** | relative `--project` broke under `npm run` (the real cause of round 1's "git ENOENT") |
| 3: + path fix, literal-union deltas, better intent matching | **5 of 5 / 4 of 4**. History loss stated explicitly; found the reviewer-override issue | (not rerun) | none |
| 4: NestJS service (`feature/order-fraud-hold`), framework adapters, no platform rules in the profile | **5 of 6** critical: missed that `cancel()` mishandles the new `held` status | (not run) | none |


Round 4 ([brief and grading](round4-haiku-order-fraud-hold.md)) tested a new framework end to end: the profile has
no entry point or side-effect rules, the adapters found them. Fixes from it: same-contract operations with changed
guards are now medium risk and no longer called "implementation only"; the skill now says to check every code path
that acts on a field that `gains` a value.

No round produced a wrong claim. From round 2 on, every brief also had correct code-level judgment beyond the facts:
non-atomic write + outbox, a race in `persist()`, overrides being overwritten, the IND policy question.

Briefs: [round1-A](round1-haiku-kyc-risk-tiers.md), [round1-B](round1-haiku-review-test.md),
[round2-A](round2-haiku-kyc-risk-tiers.md), [round2-B](round2-haiku-review-test.md), [round3-A](round3-haiku-kyc-risk-tiers.md).

## What changed because of it

1. **The analyzer writes the facts itself** (`<id>.brief.md`, [analyzer/src/brief.ts](../../analyzer/src/brief.ts)).
   It contains:
   - the verdict;
   - per contract change: output deltas (including new values of a literal union, e.g. `status gains "pending_review"`),
     effect and call deltas, **Behaviour inside** (NEW / REMOVED steps, GUARD CHANGED), changed functions and reach;
   - entry-point changes and flows that now touch something different;
   - grouped findings, owners and UI links.

   The agent no longer has to dig behaviour changes out of the JSON. Round 1 missed them for exactly that reason.
2. **No guessing**:
   - the profile is found by package name (`configs/*/modulegraph.config.json` with the same `service`);
   - the intent comes from the PR or the branch's commit messages;
   - the profile's scenario runs automatically;
   - paths are resolved from the folder the command was typed in (`INIT_CWD`), not npm's workspace;
   - git is found even when a shell hands Node an unusable PATH.
3. **`undisclosed-effect` matches meaning, not just literal names**: "manual-review outbox event" discloses
   `kyc.manual_review_requested` (all its meaningful words, close together). Tests: `npm test --workspace analyzer`.
4. **Agent-agnostic**: [AGENTS.md](../../AGENTS.md) points any coding agent (Codex, Cursor, …) at the same plain-Markdown
   procedure. The facts brief is useful without any agent at all.

## Known limits

- HTTP effects are tracked per service, not per path: `/v1/screen` → `/v2/screen` is only visible in code (Haiku caught it by reading).
- The analyzer can't know who consumes an outbox event outside this repo; the brief can only say the event changed.
- Static counts are conservative: a refetch inside a rarely taken branch still counts as fetch-once ×2 (the agent noted this correctly).

## Rerun

```bash
git worktree add -b test/preferred-name .worktrees/review-test main
git -C .worktrees/review-test apply ../../docs/agent-eval/test-b-uncommitted.patch
```

Then give a fresh agent the one-line prompts from the table above and grade against [ground-truth.md](ground-truth.md).
