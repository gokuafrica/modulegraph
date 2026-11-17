import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AcmeLogger } from '@acme/nestjs-logging';
import { Repository } from 'typeorm';
import { UserRecord } from '../../../user-records/entity/user-record.entity';
import { UserRecordStatus } from '../../../user-records/entity/user-record-status.entity';

const BATCH_SIZE = 500;

@Injectable()
export class RecordStatusBackfillService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(UserRecord, 'legacy') private readonly userRecordRepository: Repository<UserRecord>,
    @InjectRepository(UserRecordStatus, 'legacy') private readonly statusRepository: Repository<UserRecordStatus>,
    private readonly logger: AcmeLogger,
  ) {}

  async onApplicationBootstrap() {
    let migrated = 0;
    for (let offset = 0; ; offset += BATCH_SIZE) {
      const records = await this.userRecordRepository
        .createQueryBuilder('record')
        .leftJoin(UserRecordStatus, 'status', 'status.record_guid = record.guid')
        .where('status.id IS NULL')
        .take(BATCH_SIZE)
        .skip(offset)
        .getMany();
      if (!records.length) break;
      await this.statusRepository.insert(records.map((r) => ({ recordGuid: r.guid, status: r.statusCode, changedBy: 'backfill', changedAt: r.updatedAt })));
      migrated += records.length;
    }
    this.logger.info('record status backfill finished', { migrated });
    process.exit(0);
  }
}
