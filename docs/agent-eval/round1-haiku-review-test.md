# Reviewer brief: test/preferred-name (uncommitted, .worktrees/review-test)

**Goal:** add `PUT /v1/users/:userId/preferred-name` and cache `usPerson` on the profile. Intent is inferred from the diff (no PR text), so the `usPerson` cache is not described by any stated goal.

**Contract changes, riskiest first:**
1. `PersonalDetails.resolve`: now calls `Identity.fetchIdentity` when `fullName` is empty (fetch-once is broken; 2x statically), and writes `user_profiles.lastResolvedAt` on every call. Reach 6.
2. `PersonalDetails.updatePreferredName` (new): +db.write `user_profiles`, +outbox `profile.preferred_name_changed`, +db.read. Reach 1.
3. `TaxResidency.assess` / `recordDeclaration` / `weeklySweep`: +db.write `user_profiles` (`usPerson`). Reach 3 / 1 / 1. That table is owned by PersonalDetails.

**New findings:** 21 new, 10 errors.
- 7 fetch-once errors: Identity.fetchIdentity runs 2x in GET profile, GET profile/summary, POST export, PUT preferred-name, POST passport-prefill, gRPC GetProfile, and the `user.profile.changed` consumer.
- 3 table-ownership errors: TaxResidency writes `user_profiles` directly.
- Warnings: read-path-writes on 4 read-only entry points (incl. GET profile, GET tax residency, gRPC GetProfile); undisclosed-effect for `user_profiles` read/write.
- Pre-existing findings: 3 (not counted here).

**Decisions for the human:**
1. Is the conditional refetch in `resolve` intended? The comment says newer documents should win, but the code refetches only when `fullName` is empty, so that case is not covered and fetch-once breaks. Owners: team-profile, team-identity.
2. Should TaxResidency call a PersonalDetails method to store `usPerson` instead of writing `user_profiles`? Owners: team-compliance, team-profile.
3. Should `resolve` keep writing `lastResolvedAt` on every read? If not, drop it.

**Request review from:** team-profile, team-compliance.

**Start here:** http://localhost:5173/#g=test-preferred-name&v=impact&op=PersonalDetailsModule.resolve&d=1

**Notes (not graph findings):**
- Code read: `PUT preferred-name` passes `req.body.preferredName` with no validation; a missing value throws at `.trim()`.
- The scenario does not exercise the new PUT, so no recorded example exists for `updatePreferredName`.
- Run: full analysis (not lazy), 28 entry points, 4.7 s. Graph written to `ui/public/graphs/test-preferred-name.json` and appended to `ui/public/graphs/index.json` (which already had your uncommitted changes).
- The dev server on :5173 was already running. The browser was not driven, so the graph view itself is not visually verified.
