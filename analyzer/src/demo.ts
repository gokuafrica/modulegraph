/** Regenerates the demo analyses shown in the UI from the sample services' real git history. */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, 'cli.ts');
const identity = resolve(here, '../../sample-service');
const orders = resolve(here, '../../sample-nest-service');
// Everything modulegraph needs to know about a service lives outside it.
const profile = resolve(here, '../../configs/identity-profile-service');
const config = resolve(profile, 'modulegraph.config.json');
const scenario = resolve(profile, 'scenario.ts');

// --demo: these are the shipped graphs in ui/public/graphs (kept in git). Every other run writes to ~/.modulegraph/reviews.
const analyze = (args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', cli, ...args, '--demo'], { stdio: 'inherit' });
const run = (args: string[]) => analyze(['--project', identity, '--config', config, ...args]);

run(['--snapshot', '--examples', scenario, '--name', 'snapshot-main', '--title', 'Snapshot: identity-profile-service (main)']);
run([
  '--head', 'feature/birthinfo-consent',
  '--base', 'main',
  '--examples', scenario,
  '--name', 'demo-birthinfo-consent',
  '--title', 'BirthInfo: consented data wins over documents',
  '--intent', 'BirthInfo: prefer user-consented birth data (birth_info_consents) over document data; add consent endpoint.',
]);
// A change spread over several files of one module: new helper file, changed helpers, added/removed steps.
run([
  '--head', 'feature/kyc-risk-tiers',
  '--base', 'main',
  '--examples', scenario,
  '--name', 'demo-kyc-risk-tiers',
  '--title', 'KYC: risk tiers, manual review, async rescreen (multi-file)',
  '--intent', 'KYC: add risk tiers from sanctions score, birth country and nationality; send high-risk users to manual review (outbox kyc.manual_review_requested); make the nightly rescreen asynchronous via kyc.recheck_requested.',
]);
// Lazy versions of both: only the changed code and the 2 best-matching entry points analyzed.
// `npm run live` serves the birth-info one live (`-- all` for every one) so the UI can expand the rest.
for (const [head, title, intent] of [
  ['feature/birthinfo-consent', 'Live (lazy): BirthInfo consented data wins over documents', 'BirthInfo: prefer user-consented birth data (birth_info_consents) over document data; add consent endpoint.'],
  ['feature/kyc-risk-tiers', 'Live (lazy): KYC risk tiers, manual review, async rescreen', 'KYC: add risk tiers from sanctions score, birth country and nationality; send high-risk users to manual review (outbox kyc.manual_review_requested); make the nightly rescreen asynchronous via kyc.recheck_requested.'],
]) {
  run(['--head', head, '--base', 'main', '--lazy', '--examples', scenario, '--name', `live-${head.split('/').pop()}`, '--title', title, '--intent', intent]);
}

// The NestJS service: no platform rules in its profile; the framework adapters find routes, handlers and effects.
// Its intent comes from the branch's commit message, the way an agent would run it.
analyze(['--project', orders, '--head', 'feature/order-fraud-hold', '--base', 'main', '--name', 'demo-order-fraud-hold', '--title', 'Orders (NestJS): hold high-risk orders for fraud review']);
analyze(['--project', orders, '--head', 'feature/order-fraud-hold', '--base', 'main', '--lazy', '--name', 'live-order-fraud-hold', '--title', 'Live (lazy, NestJS): hold high-risk orders for fraud review']);

// NestJS with recorded examples: the profile (found by package name) brings its own scenario.ts.
const birth = resolve(here, '../../sample-birth-service');
analyze(['--project', birth, '--head', 'feature/enforce-document-birth-info', '--base', 'main', '--name', 'demo-enforce-document-birth-info', '--title', 'BirthInfo (NestJS): KYC birth info must match the identity document']);
analyze(['--project', birth, '--head', 'feature/enforce-document-birth-info', '--base', 'main', '--lazy', '--name', 'live-enforce-document-birth-info', '--title', 'Live (lazy, NestJS): KYC birth info must match the identity document']);
// The next change on top of that one, as if it had shipped: a new area (residency). `npm run live -- residency` serves it.
analyze(['--project', birth, '--head', 'feature/residency-declaration', '--base', 'feature/enforce-document-birth-info', '--lazy', '--name', 'live-residency-declaration', '--title', 'Live (lazy, NestJS): users declare their home address during KYC']);
