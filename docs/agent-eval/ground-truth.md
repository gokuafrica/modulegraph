# Ground truth for the Haiku review test (written before running the agents)

## A: feature/kyc-risk-tiers vs main (committed branch, multi-file)
Critical (must have):
- A1 KycCheck.runCheck: + db.read kyc_results (via getStatus), + outbox kyc.manual_review_requested; new status pending_review; output + riskTier. High risk.
- A2 kyc.completed is no longer emitted when a check goes to manual review (now guarded `unless (review)`); downstream consumers of kyc.completed miss those users.
- A3 persist(): updates the existing kyc_results row instead of inserting: result history is lost (one row per user).
- A4 recheckExpired no longer runs checks inline: enqueues outbox kyc.recheck_requested; new consumer `kyc.recheck_requested` → runCheck. Cron loses its direct effects.
- A5 SanctionsScreening.screen: output + score; retry → http sanctions-api twice (duplicate-read warning); /v2 endpoint; name normalisation.
Important:
- A6 riskTier policy: IND is in the enhanced-due-diligence list; thresholds; birth country ≠ nationality adds a point (human decision).
- A7 New findings: undisclosed db.read kyc_results (if intent given), new-side-effect x3, duplicate-read. No errors → --check passes.
- A8 Reviewers: team-compliance. runCheck reach: 5 entry points (POST /v1/kyc/:userId/check, gRPC RunCheck, topic user.documents.uploaded, topic kyc.recheck_requested, POST onboarding complete via Onboarding.complete).
- A9 Intent should come from the branch commit message (skill: pass --intent when known).
Wrong if: claims errors / blocking; invents effects; misses that recheck is now async.

## B: uncommitted changes in .worktrees/review-test (unseen)
Critical (must have):
- B1 PersonalDetails.resolve now WRITES user_profiles (lastResolvedAt) on every call → read-only endpoints write (GET profile, GET profile/summary, gRPC GetProfile, GET tax residency …).
- B2 PersonalDetails can refetch Identity (new IdentityModule dependency): fetch-once ERRORS on ~7 flows (GET profile, summary, export, gRPC GetProfile, passport-prefill, user.profile.changed, PUT preferred-name). Refetch is a fallback when fullName is empty; updatePreferredName fetches then resolve may fetch again.
- B3 TaxResidency.assess writes user_profiles (usPerson), owned by PersonalDetails → table-ownership ERRORS (assess, recordDeclaration, weeklySweep).
- B4 New endpoint PUT /v1/users/:userId/preferred-name → PersonalDetails.updatePreferredName: db.write user_profiles + outbox profile.preferred_name_changed.
Important:
- B5 PersonalDetails output + preferredNameUpdatedAt.
- B6 Reviewers: team-profile, team-compliance.
- B7 Errors exist → --check fails; this should be called blocking.
- B8 No PR description: undisclosed-effect check couldn't run (nice to note).
Wrong if: says no errors; misses the table-ownership or fetch-once errors; says GET endpoints are unaffected.
