# birth-info-service (NestJS demo)

A small, ordinary NestJS service with no modulegraph markers. It knows two versions of where a user was born:

- **document birth info**: what the document pipeline extracted from their identity document (`document_birth_info`).
  Either part can be missing when extraction couldn't read it, or the whole thing when it read nothing.
- **KYC birth info**: what the user told us (`kyc_birth_info`). A new submission overwrites the old one.

| API | What it does |
|---|---|
| `GET /api/users/:userId/birth-info` | both versions side by side |
| `GET /api/users/:userId/eligibility` | eligible when the birth info is complete and the country isn't restricted (KYC answer first, document as fallback) |
| `POST /api/users/:userId/birth-info` | saves the user's KYC birth info, overwriting the previous one |

```
GET  /birth-info  → BirthInfo.get → DocumentBirthInfo.forUser   document_birth_info
                                  → KycBirthInfoStore.find      kyc_birth_info
GET  /eligibility → Eligibility.check → BirthInfo.get → …
                                      → CountryPolicy.isRestricted
POST /birth-info  → BirthInfo.updateKycBirthInfo → KycBirthInfoStore.save   kyc_birth_info
                                                 → event kyc.birth_info.updated
                                                 → BirthInfo.get
```

The profile is [configs/birth-info-service](../configs/birth-info-service/modulegraph.config.json) (owners, table
owners), and [scenario.ts](../configs/birth-info-service/scenario.ts) records example calls for four users: a full
document (u-1), country only (u-2), nothing extracted (u-3) and place only (u-4).

The demo change is on branch `feature/enforce-document-birth-info`:

```bash
npm run live -- birth
```
