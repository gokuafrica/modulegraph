import { mentions } from './rules.ts';
const intent = 'KYC: risk tiers, manual review queue\n- KycModule.runCheck: pending_review status, manual-review outbox event, one row per user\n- SanctionsScreening: score in the result';
const cases: [string, string, boolean][] = [
  [intent, 'kyc.manual_review_requested', true],
  [intent, 'kyc_results', false],
  ['BirthInfo: prefer user-consented birth data (birth_info_consents) over document data', 'birth_info.source_resolved', false],
  ['BirthInfo: prefer user-consented birth data (birth_info_consents) over document data', 'birth_info_consents', true],
  ['make the nightly rescreen asynchronous via kyc.recheck_requested', 'kyc.recheck_requested', true],
];
let bad = 0;
for (const [i, t, want] of cases) if (mentions(i, t) !== want) { bad++; console.log('FAIL', t, 'expected', want); }
console.log(bad ? `${bad} failed` : 'mentions: all cases pass');
process.exit(bad ? 1 : 0);
