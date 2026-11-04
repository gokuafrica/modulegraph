/**
 * Starts a live lazy analysis of a demo branch for the UI (http://localhost:5173 proxies /api to it).
 * usage: npm run live [-- kyc]      (default: the BirthInfo branch)
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const profile = resolve(here, '../../configs/identity-profile-service');
const demos = {
  birthinfo: {
    head: 'feature/birthinfo-consent',
    title: 'Live (lazy): BirthInfo consented data wins over documents',
    intent: 'BirthInfo: prefer user-consented birth data (birth_info_consents) over document data; add consent endpoint.',
  },
  kyc: {
    head: 'feature/kyc-risk-tiers',
    title: 'Live (lazy): KYC risk tiers, manual review, async rescreen',
    intent: 'KYC: add risk tiers from sanctions score, birth country and nationality; send high-risk users to manual review (outbox kyc.manual_review_requested); make the nightly rescreen asynchronous via kyc.recheck_requested.',
  },
};
const demo = demos[(process.argv[2] ?? 'birthinfo') as keyof typeof demos] ?? demos.birthinfo;
execFileSync(process.execPath, [
  '--import', 'tsx', resolve(here, 'cli.ts'),
  '--project', resolve(here, '../../sample-service'),
  '--config', resolve(profile, 'modulegraph.config.json'),
  '--examples', resolve(profile, 'scenario.ts'),
  '--head', demo.head, '--base', 'main',
  '--lazy', '--serve',
  '--name', `live-${demo.head.split('/').pop()}`,
  '--title', demo.title,
  '--intent', demo.intent,
], { stdio: 'inherit' });
