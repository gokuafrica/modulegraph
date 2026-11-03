# identity-profile-service (demo)

A small but realistic backend used to demo module-level review. It runs in-process: an in-memory DB, a fake
Kafka, and stubbed HTTP dependencies, so there is nothing to install.

## Where the two versions of the code are

| Version | Folder | What the diagrams call it |
|---|---|---|
| Before the change (`main`) | [`sample-service/`](.) | *base* |
| After the change (`feature/birthinfo-consent`) | [`.worktrees/birthinfo-consent/sample-service/`](../.worktrees/birthinfo-consent/sample-service) | *head*: what the demo review shows |

The diagram for the demo PR shows the **head** version. To compare, open
`.worktrees/birthinfo-consent/sample-service/src/modules/birth-info/BirthInfoModule.ts` next to the same file here.
The full diff is `git diff main...feature/birthinfo-consent -- sample-service`.

## Modules (what the boxes are)

The service has no modulegraph markers: it is ordinary code. Each box in the graph is a class the analyzer found
through constructor injection (see `src/app.ts`). Public methods are its operations. Display names, owners and
which classes are the DB/Kafka/HTTP clients come from the external profile in
[`configs/identity-profile-service/`](../configs/identity-profile-service).

| Module (diagram name) | File | Direct side effects |
|---|---|---|
| **Identity** | `src/modules/identity/IdentityModule.ts` | none; composes the two below |
| DocumentStore | `src/modules/identity/DocumentStore.ts` | reads `user_documents` |
| DocumentExtractor | `src/modules/identity/DocumentExtractor.ts` | calls `document-ai` |
| **Nationality** | `src/modules/nationality/NationalityModule.ts` | reads `country_codes` |
| **PersonalDetails** | `src/modules/personal-details/PersonalDetailsModule.ts` | reads `user_profiles` |
| **BirthInfo** | `src/modules/birth-info/BirthInfoModule.ts` | head: emits outbox `birth_info.source_resolved` |
| BirthConsentStore *(head only)* | `src/modules/birth-info/BirthConsentStore.ts` | reads/writes `birth_info_consents` |
| DocumentBirthExtractor | `src/modules/birth-info/DocumentBirthExtractor.ts` | none (pure) |
| ProfileAssembler (name from the profile) | `src/modules/profile/ProfileService.ts` | writes `gdpr_exports`, produces `privacy.export.ready` |
| KycCheck (name from the profile) | `src/modules/kyc/KycModule.ts` | `kyc_results`, outbox `kyc.completed` |
| SanctionsScreening | `src/modules/kyc/SanctionsScreening.ts` | calls `sanctions-api` |
| TaxResidency | `src/modules/tax/TaxResidencyModule.ts` | `tax_declarations`, `tax_residency_assessments` |
| TravelEligibility | `src/modules/travel/TravelEligibilityModule.ts` | calls `visa-rules-service`, writes `passport_prefills` |
| Onboarding | `src/modules/onboarding/OnboardingModule.ts` | writes `users`, produces `user.onboarded` |
| ComplianceReport | `src/modules/compliance/ComplianceReportModule.ts` | calls `regulator-reporting` |
| IdentityReview | `src/modules/admin/IdentityReviewModule.ts` | reads `review_notes` |

The shape the demo is about: an orchestrator (ProfileAssembler, KycCheck, TaxResidency, TravelEligibility,
IdentityReview) calls `Identity.fetchIdentity` **once** and passes the result to Nationality, PersonalDetails and
BirthInfo. None of them refetch it; the `fetch-once` rule checks that.

## Entry points (where flows start): 28 in head

| Kind | File | Count |
|---|---|---|
| REST | `src/entrypoints/http/profileRoutes.ts`, `complianceRoutes.ts`, `adminRoutes.ts` | 16 (head adds `PUT …/birth-info/consent`) |
| gRPC | `src/entrypoints/grpc.ts` | 4 |
| Kafka consumers | `src/entrypoints/consumers.ts` | 5 |
| Cron jobs | `src/entrypoints/cron.ts` | 3 |

22 of them reach BirthInfo (directly or via KycCheck, TaxResidency, Onboarding, ComplianceReport…). Six never
touch it: profile summary, nationality, KYC status, KYC override, `DELETE /v1/users/:userId`, and the
`user.deleted` consumer.

Wiring (who gets which collaborator) is in `src/app.ts`; the platform fakes are in `src/platform/`.

## Run it

```bash
npm run smoke --workspace sample-service     # u-1 gets document data, u-2 gets consented data (on the branch)
npm start --workspace sample-service         # HTTP on http://localhost:3001/v1/users/u-1/profile
```

`configs/identity-profile-service/scenario.ts` (outside the service) is the tour the analyzer runs with
`--examples` to record the example inputs/outputs shown in the diagrams. It uses the service's own
`src/dev/seed.ts`, which has the two demo users.
