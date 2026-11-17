import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Escalation } from '../entity/escalation.entity';
import { ResolveEscalationDto } from '../dto/escalation.dto';
import { ManualReviewService } from '../../manual-review/services/manual-review.service';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { AuditLogService } from '../../audit-log/services/audit-log.service';

@Injectable()
export class EscalationsService {
  constructor(
    @InjectRepository(Escalation, 'admin') private readonly escalationRepository: Repository<Escalation>,
    private readonly manualReviewService: ManualReviewService,
    private readonly notificationsService: NotificationsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async open(recordGuid: string, reason: string, openedBy: string): Promise<Escalation> {
    const escalation = await this.escalationRepository.save({ recordGuid, reason, openedBy, state: 'OPEN' });
    await this.notificationsService.notifyEscalation(recordGuid, reason, openedBy);
    await this.auditLogService.record(recordGuid, 'ESCALATED', openedBy, { reason });
    return escalation;
  }

  async resolve(escalationId: number, seniorAgentGuid: string, dto: ResolveEscalationDto): Promise<Escalation> {
    const escalation = await this.escalationRepository.findOne({ where: { id: escalationId } });
    if (!escalation) {
      throw new NotFoundException(`Escalation ${escalationId} not found`);
    }
    if (dto.outcome === 'APPROVE') {
      await this.manualReviewService.approveUserRecord(seniorAgentGuid, escalation.recordGuid, dto.decision);
    }
    await this.escalationRepository.update({ id: escalationId }, { state: 'RESOLVED', resolvedBy: seniorAgentGuid });
    return { ...escalation, state: 'RESOLVED', resolvedBy: seniorAgentGuid };
  }
}
