# Reviewer brief: uncommitted, .worktrees/review-test (sample-service)

**Goal:** no intent given (no PR, no commits, no description). The diff adds `PUT /v1/users/:userId/preferred-name`, a `usPerson` cache written from tax, a `lastResolvedAt` write on every profile read, and a conditional identity refetch in `resolve`. Nothing states why. Ask the author.

**Verdict:** BLOCKING (10 new errors, `--check` fails).

**Contract changes, riskiest first:**
1. `PersonalDetails.resolve` (reach 6): output adds `preferredNameUpdatedAt`. Refetches identity when `fullName` is empty (line 27). Writes `user_profiles.lastResolvedAt` on every call (line 28), so GET profile, GET summary, gRPC GetProfile, travel and export now write on read paths. Code check: `preferredName` uses `??`, so a stored empty string never falls back to the legal name.
2. `TaxResidency.assess` / `recordDeclaration` / `weeklySweep` (reach 3 / 1 / 1): writes `user_profiles.usPerson` (line 32). That table is owned by PersonalDetails. `Db.update` is a silent no-op when no profile row exists, so the cache is skipped for those users. GET residency now writes too.
3. `PersonalDetails.updatePreferredName` (new, reach 1): writes `preferredName` before calling `fetchIdentity`, then enqueues `profile.preferred_name_changed`. If the fetch throws, the name and event are already saved. The write and the outbox insert are separate calls, not one transaction. `req.body.preferredName` is not validated: a missing value throws at `.trim()`, and a whitespace-only value is stored as `""`.

**New entry points:** `PUT /v1/users/:userId/preferred-name` (profileRoutes.ts:9).

**Findings:**
- table-ownership ×3: TaxResidency writes `user_profiles` directly (assess, recordDeclaration, weeklySweep).
- fetch-once ×7 (static count): Identity.fetchIdentity shown as 2× in 7 flows. Code check: the second fetch runs only when `fullName` is empty. Normal calls fetch once, because callers already pass identity into `resolve`. The error is still valid for the empty-name case, and the comment's reason (newer documents) only applies when the name is empty.
- read-path-writes ×1 (4 read entry points: gRPC GetProfile, GET residency, GET profile, GET summary).
- new-side-effect ×7 (warning) and one info (`db.read user_profiles` in the new PUT).
- Pre-existing: 3 (not counted).

**Decisions for the human (1–3):**
1. What is this change for? No intent is recorded, and the `usPerson` cache and `lastResolvedAt` have no stated purpose. Owners: team-profile, team-compliance.
2. Is the refetch in `resolve` intended? It runs only when `fullName` is empty, while the comment says newer documents should win in general. Owners: team-profile.
3. Should `usPerson` be stored through a PersonalDetails method instead of a direct `user_profiles` write? Owners: team-compliance, team-profile.

**Request review from:** team-profile, team-compliance.

**Start here:** http://localhost:5173/#g=uncommitted-working-tree&v=impact&op=PersonalDetailsModule.resolve&d=1

**Notes (not graph findings):**
- Run: `npm run analyze -- --project <absolute path to sample-service> --uncommitted`. The relative path failed: `npm run` changes cwd to `analyzer/`, so `git.ts` ran in a nonexistent directory and reported `git.exe ENOENT`. Using an absolute path fixed it.
- Graph files written: `ui/public/graphs/uncommitted-working-tree.json` and `.brief.md`. I did not verify the `index.json` entry or open the UI.
- The worktree is unchanged by the analysis (same 4 modified files).
