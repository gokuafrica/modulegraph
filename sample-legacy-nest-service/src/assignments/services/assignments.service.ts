import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { Assignment } from '../entity/assignment.entity';
import { DateService } from '../../date/services/date.service';
import { NotificationsService } from '../../notifications/services/notifications.service';

@Injectable()
export class AssignmentsService {
  constructor(
    @InjectRepository(Assignment, 'admin') private readonly assignmentRepository: Repository<Assignment>,
    private readonly dateService: DateService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async assign(recordGuid: string, agentGuid: string): Promise<Assignment> {
    const assignment = await this.assignmentRepository.save({ recordGuid, agentGuid, assignedAt: this.dateService.now() });
    await this.notificationsService.notifyAgentAssigned(agentGuid, recordGuid);
    return assignment;
  }

  findOpenForAgent(agentGuid: string): Promise<Assignment[]> {
    return this.assignmentRepository.find({ where: { agentGuid, closedAt: IsNull() } });
  }

  findStale(olderThanHours: number): Promise<Assignment[]> {
    const before = this.dateService.addHours(this.dateService.now(), -olderThanHours);
    return this.assignmentRepository.find({ where: { closedAt: IsNull(), assignedAt: LessThan(before) } });
  }
}
