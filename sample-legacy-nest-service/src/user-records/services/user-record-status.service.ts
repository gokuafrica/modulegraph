import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryRunner, Repository } from 'typeorm';
import { UserRecord } from '../entity/user-record.entity';
import { UserRecordStatus } from '../entity/user-record-status.entity';
import { UserRecordStatusCode } from '../user-record-status.enum';
import { DateService } from '../../date/services/date.service';
import { OutboxEventsService } from '../../outbox/services/outbox-events.service';

@Injectable()
export class UserRecordStatusService {
  constructor(
    @InjectRepository(UserRecordStatus, 'legacy') private readonly statusRepository: Repository<UserRecordStatus>,
    private readonly dateService: DateService,
    private readonly outboxEventsService: OutboxEventsService,
  ) {}

  async setStatus(queryRunner: QueryRunner, userRecords: UserRecord[], status: UserRecordStatusCode, changedBy: string): Promise<void> {
    const changedAt = this.dateService.now();
    const guids = userRecords.map((r) => r.guid);
    await queryRunner.manager.getRepository(UserRecord).update(guids.map((guid) => ({ guid })) as never, { statusCode: status });
    await queryRunner.manager.getRepository(UserRecordStatus).insert(guids.map((recordGuid) => ({ recordGuid, status, changedBy, changedAt })));
    await this.outboxEventsService.publish(queryRunner, 'user_record.status_changed', { guids, status, changedBy, changedAt });
  }

  getHistory(recordGuid: string): Promise<UserRecordStatus[]> {
    return this.statusRepository.find({ where: { recordGuid }, order: { changedAt: 'DESC' } });
  }
}
