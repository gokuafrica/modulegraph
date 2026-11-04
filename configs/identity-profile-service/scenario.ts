import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Tour of identity-profile-service, run by `modulegraph --examples` to record real module inputs/outputs.
 * Lives outside the service repo: it loads the service from `projectRoot`, which is the revision under review
 * (a temporary worktree for branches/PRs).
 * u-1 has only identity documents; u-2 has documents and (from the consent feature on) consented birth data.
 * Each request runs in its own `step`: every module call it makes is recorded as part of that case, so the UI
 * shows the same request (same user, same data) in every module it passes through.
 */
type Step = <T>(label: string, fn: () => Promise<T> | T) => Promise<T | undefined>;

export default async function scenario(projectRoot: string, { step }: { step: Step }): Promise<void> {
  const load = (path: string) => import(pathToFileURL(join(projectRoot, path)).href);
  const { buildApp } = await load('src/app.ts');
  const { seed } = await load('src/dev/seed.ts');
  const app = buildApp();
  await seed(app);
  const call = (method: string, url: string, body?: unknown) => step(`${method} ${url}`, () => app.router.dispatch(method, url, body));

  for (const user of ['u-1', 'u-2']) {
    await call('GET', `/v1/users/${user}/profile`);
    await call('GET', `/v1/users/${user}/birth-info`);
    await call('GET', `/v1/users/${user}/profile/summary`);
    await call('GET', `/v1/users/${user}/nationality`);
    await call('POST', `/v1/kyc/${user}/check`);
    await call('GET', `/v1/kyc/${user}/status`);
    await call('GET', `/v1/tax/${user}/residency`);
    await call('GET', `/v1/travel/${user}/visa-eligibility?destination=USA`);
    await call('POST', `/v1/travel/${user}/passport-prefill`);
    await call('GET', `/admin/v1/users/${user}/identity-review`);
  }
  await call('POST', '/v1/onboarding/u-1/complete');
  await call('POST', '/v1/tax/u-2/declarations', { country: 'GBR' });
  await call('POST', '/v1/users/u-1/export');
  await call('POST', '/admin/v1/users/u-2/kyc-override', { status: 'passed', reviewer: 'ops-17' });

  for (const [method, request] of app.grpc.methods as Map<string, (req: unknown) => Promise<unknown>>) {
    if (method.endsWith('CheckVisa')) await step(`gRPC ${method} u-2`, () => request({ userId: 'u-2', destination: 'JPN' }));
    else await step(`gRPC ${method} u-1`, () => request({ userId: 'u-1' }));
  }
  await step('topic user.profile.changed u-2', () => app.kafka.produce('user.profile.changed', { userId: 'u-2' }));
  await step('topic travel.booking.created u-1', () => app.kafka.produce('travel.booking.created', { userId: 'u-1', destination: 'CAN' }));
  for (const { name, job } of app.scheduler.jobs as { name?: string; job: () => Promise<void> }[]) await step(`cron ${name ?? 'job'}`, job);

  // Exists from the consent feature on (404 before it): u-1 consents last so earlier calls stay document-based.
  await call('PUT', '/v1/users/u-1/birth-info/consent', { countryOfBirth: 'PRT', cityOfBirth: 'Lisbon' });
}
