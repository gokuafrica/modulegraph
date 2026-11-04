/** Regenerates the demo analyses shown in the UI from the sample service's real git history. */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, 'cli.ts');
const project = resolve(here, '../../sample-service');
// Everything modulegraph needs to know about the service lives outside it.
const profile = resolve(here, '../../configs/identity-profile-service');
const config = resolve(profile, 'modulegraph.config.json');
const scenario = resolve(profile, 'scenario.ts');

const run = (args: string[]) =>
  execFileSync(process.execPath, ['--import', 'tsx', cli, '--project', project, '--config', config, ...args], { stdio: 'inherit' });

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
