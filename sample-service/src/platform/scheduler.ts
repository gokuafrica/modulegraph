type Job = () => Promise<void>;

/** Cron jobs. Schedules are standard 5-field cron expressions. */
export class Scheduler {
  readonly jobs: { name: string; schedule: string; job: Job }[] = [];

  cron(name: string, schedule: string, job: Job): void {
    this.jobs.push({ name, schedule, job });
  }
}
