import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AcmeAvroProducer, KafkaJsService } from '@acme/nestjs-kafkajs';
import { KafkaTopicsConfig } from '../../config/configuration';
import { UserRecordService } from '../../user-records/services/user-record.service';

interface RecordDuplicateFoundSchema {
  recordGuid: string;
  duplicateOf: string;
  userGuid: string;
}

@Injectable()
export class DuplicateRecordsService {
  private readonly producer: AcmeAvroProducer;

  constructor(
    kafkaService: KafkaJsService,
    private readonly configService: ConfigService,
    private readonly userRecordService: UserRecordService,
  ) {
    this.producer = kafkaService.producer({ allowAutoTopicCreation: false });
  }

  async reportDuplicate(recordGuid: string, duplicateOf: string): Promise<void> {
    const record = await this.userRecordService.getByGuidOrFail(recordGuid);
    const topic = this.configService.get<KafkaTopicsConfig>('KAFKA_TOPICS').RECORD_DUPLICATE_FOUND;
    await this.producer.send<RecordDuplicateFoundSchema>({
      subject: `${topic}-value`,
      topic,
      messages: [{ key: recordGuid, value: { recordGuid, duplicateOf, userGuid: record.userGuid } }],
    });
  }
}
