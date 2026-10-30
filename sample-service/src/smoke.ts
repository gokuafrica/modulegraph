import { buildApp } from './app.ts';
import { seed } from './dev/seed.ts';

const app = buildApp();
await seed(app);

for (const userId of ['u-1', 'u-2']) {
  const res = await app.router.dispatch('GET', `/v1/users/${userId}/profile`);
  console.log(userId, JSON.stringify((res.body as { birth: unknown }).birth));
}
const kyc = await app.router.dispatch('POST', '/v1/kyc/u-1/check');
console.log('kyc', JSON.stringify(kyc.body));
console.log('entry points:', 'http routes + grpc', app.grpc.methods.size, 'cron', app.scheduler.jobs.length);
