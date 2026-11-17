import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { AcmeLogger } from '@acme/nestjs-logging';
import { AssignmentsService } from '../../../assignments/services/assignments.service';
import { NotificationsService } from '../../../notifications/services/notifications.service';

@Injectable()
export class EscalationDigestService implements OnApplicationBootstrap {
  constructor(
    private readonly assignmentsService: AssignmentsService,
    private readonly notificationsService: NotificationsService,
    private readonly logger: AcmeLogger,
  ) {}

  async onApplicationBootstrap() {
    const stale = await this.assignmentsService.findStale(24);
    if (stale.length) {
      await this.notificationsService.notifyStaleReviews(stale.map((a) => a.recordGuid));
    }
    this.logger.info('escalation digest sent', { records: stale.length });
  }
}
