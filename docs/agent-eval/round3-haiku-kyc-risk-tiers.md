**Goal:** Risk tiers, a manual-review queue and async nightly rescreen. The contracts match this, but one row per user (update instead of insert) also drops result history, which the intent never mentions.
**Verdict:** not blocked by checks. No new errors, 4 new warnings.
**Contract changes, riskiest first:**
- KycCheck.runCheck (reach 5, team-compliance): output +riskTier, status may be pending_review. GUARD CHANGED db.write kyc_results: now an update when a previous row exists (before: always insert, history kept). NEW db.write kyc_results (insert) when none exists. NEW db.read kyc_results. NEW outbox kyc.manual_review_requested when review. GUARD CHANGED outbox kyc.completed: now only when not review. Code matches (KycModule.ts:31-51, persist :72-75).
- KycCheck.recheckExpired (reach 1, nightly cron): inline checks removed; now enqueues kyc.recheck_requested per expired row, consumed by a new consumer (consumers.ts:9) that calls runCheck. Matches.
- SanctionsScreening.screen (reach 5, medium): output +score; NEW http sanctions-api on error (retry). NOT in the facts: the first call's path changed /v1/screen to /v2/screen and the name is now NFKD-normalised and uppercased (SanctionsScreening.ts:16-30).
**New entry points:** topic kyc.recheck_requested (consumers.ts:9), reaches runCheck.
**Findings:**
- duplicate-read x1: screen, 2x sanctions-api. This is the retry (lines 20-23), not a redundant read. The retry also fires on any error, not only timeouts as its comment says.
- new-side-effect x3: manual_review and recheck outbox events are intended. The new db.read kyc_results is needed by persist and the review rule, but runs on all 5 flows.
- undisclosed-effect x1: that read. Commits say "one row per user" but not the read. Documentation gap.
- unattributed-change x1: src/dev/seed.ts stub returns a score. Dev data only.
- Pre-existing: 3 (not listed).
**Judgment (not in the facts):**
- A reviewer override is overwritten: persist() writes status over the row (KycModule.ts:73) on the next run, but overriddenBy stays set. A nightly recheck or new document can replace a manual decision.
- ComplianceReportModule.generateMonthly (reads all kyc_results, sends to regulator) now gets one row per user, with pending_review rows and no history.
- Downstream: pending_review emits no kyc.completed, and override emits kyc.overridden. No consumer of either is in this repo.
- Policy constants with no owner: thresholds 6 and 3, score x10, and ENHANCED_DUE_DILIGENCE (IRN, PRK, SYR, MMR, IND) in riskTier.ts:6-22. IND raises risk by birth or nationality.
- recheckExpired enqueues every expired row each night and nothing marks them, so a slow consumer can get duplicates. Not checked against the outbox.
**Decisions for the human (1-3):**
1. Does team-compliance need an append-only KYC history, given the regulator report reads kyc_results?
2. Should a reviewer's override survive re-runs, and should onboarding wait on kyc.completed (no longer sent for pending_review) or kyc.overridden?
3. Is sanctions-api /v2/screen live and compatible, and is the name normalisation meant to change matching?
**Request review from:** team-compliance
**Start here:** http://localhost:5173/#g=branch-feature-kyc-risk-tiers&v=impact&op=KycModule.runCheck&d=1
