**Goal:** KYC risk tiers (sanctions score + birth country + nationality), a `pending_review` path for manual review, one `kyc_results` row per user, and nightly rescreen moved to an async `kyc.recheck_requested` event. The contract changes match this goal.

**Contract changes (riskiest first):**
1. `KycModule.runCheck` (reach 5): output adds `riskTier` and `pending_review`; +db.read `kyc_results`; +outbox `kyc.manual_review_requested`.
2. `KycModule.recheckExpired` (reach 1): no longer runs checks inline; +outbox `kyc.recheck_requested`; its old direct effects (sanctions-api, document-ai, db writes) move to the new consumer, which calls `runCheck`.
3. `SanctionsScreening.screen` (reach 5): output adds `score`; calls `/v2/screen` with one retry in the `catch` branch.

**New findings:** 0 errors, 4 warnings, 2 info. 3 pre-existing findings not counted.
- warning `duplicate-read`: sanctions-api called 2x in `screen`. This comes from the retry in `catch`; the happy path makes one call. The retry also fires on non-timeout errors.
- warning `undisclosed-effect`: `kyc.manual_review_requested` is not in the intent. Likely a wording artifact of the intent text, so confirm against the PR description.

**Decisions for the human (team-compliance):**
1. `IND` is on the enhanced-due-diligence list. The seeded Raj Patel (IND birth and passport, score 0.31) scores 8, which is `high` and always goes to review. Is that the intended weight?
2. High tier always queues review, even after a previous pass, so each nightly recheck re-queues high-tier users. Intended?

**Request review from:** team-compliance (owner of `sample-service/src/modules/kyc/**`).

**Open:** http://localhost:5173/#g=haiku-kyc-risk-tiers&v=impact&op=KycModule.runCheck&d=1
