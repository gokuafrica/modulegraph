**Goal:** KYC risk tiers, a manual-review queue and an async nightly rescreen (from commit messages; no PR description). The contract changes match it, but two effects are not in the intent: the sanctions endpoint moved to /v2, and onboarding now blocks on `pending_review`.
**Verdict:** Not blocked by checks. No new errors; 5 new warnings.
**Contract changes, riskiest first:**
- KycCheck.runCheck (reach 5, team-compliance): output +riskTier, status may be `pending_review`. Behaviour inside: NEW db.read `kyc_results` (getStatus); GUARD CHANGED db.write `kyc_results` now only when a previous row exists (was always); NEW db.write `kyc_results` when none exists (persist); NEW outbox `kyc.manual_review_requested` only when review; GUARD CHANGED outbox `kyc.completed` now only when not review (was always).
- KycCheck.recheckExpired (reach 1, cron only): REMOVED the inline checks (identity, birth info, nationality, sanctions, document-ai, country_codes, user_documents reads, kyc_results write, kyc.completed); NEW outbox `kyc.recheck_requested` per expired row. Results now arrive later via the new consumer.
- SanctionsScreening.screen (reach 5, team-compliance): output +score. Behaviour inside: NEW second identical POST on any error (no backoff). Not in the analyzer facts: endpoint changed `/v1/screen` to `/v2/screen`, and the name is normalised (NFKD, accents stripped, uppercased) before it is sent.
**New entry points:** `topic kyc.recheck_requested` (consumers.ts:9) to runCheck. Only recheckExpired feeds it and runCheck does not emit it, so there is no loop.
**Findings:** Analyzer: new-side-effect ×3 (runCheck db.read and outbox; recheckExpired outbox), duplicate-read ×1, undisclosed-effect ×2, unattributed-change ×1 (dev/seed.ts). Pre-existing: 3 (count only).
- Analyzer false positives: the undisclosed-effect for `kyc.manual_review_requested` is wrong, since the commit intent says "manual-review outbox event". The duplicate-read is a retry after an error, not a redundant read.
- Code, not in the facts: OnboardingModule.ts:17 returns `onboarded: false` for any status other than `passed`, so manual-review users are no longer onboarded.
- Code, not in the facts: persist() reads the previous row, then inserts or updates. Two concurrent runCheck calls for one user can both see no row and insert two. getStatus takes `[latest]` with no ordering.
- Code, not in the facts: the nightly cron re-enqueues every expired row until the consumer clears it. If the consumer lags, duplicate manual-review events follow.
**Decisions for the human (1–3):**
1. Is the enhanced-due-diligence list in riskTier.ts:6 (IRN, PRK, SYR, MMR, IND) and the tier thresholds (medium at 3 points, high at 6, +1 for birth/nationality mismatch) approved policy? IND on that list needs a compliance answer.
2. Should a medium-tier user whose last result is `expired` go to manual review? needsManualReview treats any non-passed previous as review, and `expired` is the normal state for the nightly rescreen.
3. Is the sanctions provider's `/v2/screen` live, and was the endpoint change meant to ship in this branch?
**Request review from:** team-compliance
**Start here:** http://localhost:5173/#g=branch-feature-kyc-risk-tiers&v=impact&op=KycModule.runCheck&d=1
