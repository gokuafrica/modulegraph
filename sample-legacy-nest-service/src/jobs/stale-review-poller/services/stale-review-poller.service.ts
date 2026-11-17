import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AcmeLogger } from '@acme/nestjs-logging';
import { AssignmentsService } from '../../../assignments/services/assignments.service';
import { EscalationsService } from '../../../escalations/services/escalations.service';
import { NotificationsService } from '../../../notifications/services/notifications.service';

const POLL_INTERVAL_MS = 5 * 60_000;

@Injectable()
export class StaleReviewPollerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout;

  constructor(
    private readonly assignmentsService: AssignmentsService,
    private readonly escalationsService: EscalationsService,
    private readonly notificationsService: NotificationsService,
    private readonly configService: ConfigService,
    private readonly logger: AcmeLogger,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    void this.poll();
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  private async poll() {
    const stale = await this.assignmentsService.findStale(this.configService.get<number>('staleReviewHours'));
    if (!stale.length) {
      return;
    }
    this.logger.info('stale reviews found', { count: stale.length });
    for (const assignment of stale) {
      await this.escalationsService.open(assignment.recordGuid, 'review not finished in time', 'stale-review-poller');
    }
    await this.notificationsService.notifyStaleReviews(stale.map((a) => a.recordGuid));
  }
}
