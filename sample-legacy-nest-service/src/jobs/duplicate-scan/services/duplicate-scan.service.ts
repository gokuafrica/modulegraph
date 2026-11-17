import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { AcmeLogger } from '@acme/nestjs-logging';
import { UserRecordService } from '../../../user-records/services/user-record.service';
import { DuplicateRecordsService } from '../../../duplicates/services/duplicate-records.service';

@Injectable()
export class DuplicateScanService implements OnApplicationBootstrap {
  constructor(
    private readonly userRecordService: UserRecordService,
    private readonly duplicateRecordsService: DuplicateRecordsService,
    private readonly logger: AcmeLogger,
  ) {}

  async onApplicationBootstrap() {
    const [pending] = await this.userRecordService.findPendingReview(1000, 0);
    const seen = new Map<string, string>();
    for (const record of pending) {
      const key = `${record.userGuid}:${record.recordType}`;
      if (seen.has(key)) {
        await this.duplicateRecordsService.reportDuplicate(record.guid, seen.get(key));
      } else {
        seen.set(key, record.guid);
      }
    }
    this.logger.info('duplicate scan finished', { scanned: pending.length });
  }
}
