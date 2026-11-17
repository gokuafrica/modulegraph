import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AcmeLogger } from '@acme/nestjs-logging';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { AuditEventsPublisher } from '../../../audit-log/services/audit-events.publisher';
import { KafkaTopicsConfig } from '../../../config/configuration';
import { KmsService } from '../../../kms/services/kms.service';
import { UserRecord } from '../../../user-records/entity/user-record.entity';

@Injectable()
export class ManualDataReencryptService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(UserRecord, 'legacy') private readonly userRecordRepository: Repository<UserRecord>,
    private readonly kmsService: KmsService,
    private readonly auditEventsPublisher: AuditEventsPublisher,
    private readonly configService: ConfigService,
    private readonly logger: AcmeLogger,
  ) {}

  async onApplicationBootstrap() {
    const records = await this.userRecordRepository.find({ where: { manualData: Not(IsNull()) } });
    for (const record of records) {
      const plaintext = await this.kmsService.decryptString(record.manualData);
      record.manualData = await this.kmsService.encryptString(plaintext);
      await this.userRecordRepository.save(record);
      await this.auditEventsPublisher.publishRaw({
        topic: this.configService.get<KafkaTopicsConfig>('KAFKA_TOPICS').MANUAL_DATA_REENCRYPTED,
        key: record.guid,
        value: { guid: record.guid, reencryptedAt: new Date().toISOString() },
      });
    }
    this.logger.info('manual data re-encrypted', { records: records.length });
  }
}
