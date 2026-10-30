import type { Modules } from '../app.ts';
import { Scheduler } from '../platform/scheduler.ts';

export function registerCronJobs(scheduler: Scheduler, m: Modules): void {
  scheduler.cron('kyc-nightly-rescreen', '0 2 * * *', async () => {
    await m.kyc.recheckExpired();
  });

  scheduler.cron('tax-weekly-sweep', '0 4 * * 1', async () => {
    await m.tax.weeklySweep();
  });

  scheduler.cron('compliance-monthly-report', '0 6 1 * *', async () => {
    await m.compliance.generateMonthly();
  });
}
