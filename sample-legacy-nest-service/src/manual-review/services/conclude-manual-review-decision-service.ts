import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { TypeORMOutboxService } from '@acme/typeorm-outbox-writer';
import { KmsService } from '../../kms/services/kms.service';
import { DateService } from '../../date/services/date.service';
import { RequestContextService } from '../../request-context/services/request-context.service';
import { SyncedMessageService } from '../../outbox/services/synced-message.service';
import { UserRecordService } from '../../user-records/services/user-record.service';
import { UserRecordStatusService } from '../../user-records/services/user-record-status.service';
import { UserRecordDataTransformer } from '../../user-records/services/user-record-data.transformer';
import { UserRecord } from '../../user-records/entity/user-record.entity';
import { UserRecordStatusCode } from '../../user-records/user-record-status.enum';
import { ManualReviewDecision } from '../entity/manual-review-decision.entity';
import { ApproveDecisionDto } from '../dto/approve-decision.dto';
import { RejectDecisionDto, UpdateUserRecordDataDto } from '../dto/update-user-record-data.dto';
import { ManualReviewResultDto } from '../dto/manual-review-result.dto';

interface TransactionContext {
  name: 'legacy' | 'admin';
  queryRunner: QueryRunner;
}

@Injectable()
export class ConcludeManualReviewDecisionService {
  constructor(
    @InjectDataSource('legacy') private readonly legacyDataSource: DataSource,
    @InjectDataSource('admin') private readonly adminDataSource: DataSource,
    private readonly kmsService: KmsService,
    private readonly dateService: DateService,
    private readonly userRecordService: UserRecordService,
    private readonly requestContextService: RequestContextService,
    private readonly userRecordStatusService: UserRecordStatusService,
    private readonly userRecordDataTransformer: UserRecordDataTransformer,
    private readonly syncedMessageService: SyncedMessageService,
    private readonly outboxService: TypeORMOutboxService,
  ) {}

  async approve(agentGuid: string, guid: string, decision: ApproveDecisionDto): Promise<ManualReviewResultDto> {
    const record = await this.userRecordService.getByGuid(guid);
    if (!record) {
      throw new NotFoundException(`User record ${guid} not found`);
    }
    const userRecords = await this.userRecordService.findAllByUserGuid(record.userGuid);
    const transactionContexts = await this.startTransactions();
    try {
      await this.setUserRecordManualData(transactionContexts, userRecords, decision.data);
      await this.userRecordStatusService.setStatus(this.runnerFor(transactionContexts, 'legacy'), userRecords, UserRecordStatusCode.APPROVED, agentGuid);
      await this.saveDecision(this.runnerFor(transactionContexts, 'admin'), agentGuid, guid, 'APPROVED', decision.reason);
      const syncedMessage = await this.syncedMessageService.createSyncedMessage(guid, record.id, 'UserRecordApprovedNotification');
      await this.outboxService.createOutboxMessage(syncedMessage, this.runnerFor(transactionContexts, 'legacy').manager);
      await Promise.all(transactionContexts.map(({ queryRunner }) => queryRunner.commitTransaction()));
    } catch (error) {
      await Promise.all(transactionContexts.map(({ queryRunner }) => queryRunner.rollbackTransaction()));
      throw error;
    } finally {
      await Promise.all(transactionContexts.map(({ queryRunner }) => queryRunner.release()));
    }
    return { guid, status: UserRecordStatusCode.APPROVED, reviewedBy: agentGuid, reviewedAt: this.dateService.now(), recordsUpdated: userRecords.length };
  }

  async correctData(agentGuid: string, guid: string, dto: UpdateUserRecordDataDto): Promise<ManualReviewResultDto> {
    const record = await this.userRecordService.getByGuid(guid);
    if (!record) {
      throw new NotFoundException(`User record ${guid} not found`);
    }
    const userRecords = await this.userRecordService.findAllByUserGuid(record.userGuid);
    const transactionContexts = await this.startTransactions();
    try {
      await this.setUserRecordManualData(transactionContexts, userRecords, dto.data);
      await this.saveDecision(this.runnerFor(transactionContexts, 'admin'), agentGuid, guid, 'DATA_UPDATED', dto.reason);
      await Promise.all(transactionContexts.map(({ queryRunner }) => queryRunner.commitTransaction()));
    } catch (error) {
      await Promise.all(transactionContexts.map(({ queryRunner }) => queryRunner.rollbackTransaction()));
      throw error;
    } finally {
      await Promise.all(transactionContexts.map(({ queryRunner }) => queryRunner.release()));
    }
    return { guid, status: record.statusCode, reviewedBy: agentGuid, reviewedAt: this.dateService.now(), recordsUpdated: userRecords.length };
  }

  async reject(agentGuid: string, guid: string, dto: RejectDecisionDto): Promise<ManualReviewResultDto> {
    const record = await this.userRecordService.getByGuidOrFail(guid);
    const transactionContexts = await this.startTransactions();
    try {
      await this.userRecordStatusService.setStatus(this.runnerFor(transactionContexts, 'legacy'), [record], UserRecordStatusCode.REJECTED, agentGuid);
      await this.saveDecision(this.runnerFor(transactionContexts, 'admin'), agentGuid, guid, 'REJECTED', dto.reason);
      const syncedMessage = await this.syncedMessageService.createSyncedMessage(guid, record.id, 'UserRecordRejectedNotification');
      await this.outboxService.createOutboxMessage(syncedMessage, this.runnerFor(transactionContexts, 'legacy').manager);
      await Promise.all(transactionContexts.map(({ queryRunner }) => queryRunner.commitTransaction()));
    } catch (error) {
      await Promise.all(transactionContexts.map(({ queryRunner }) => queryRunner.rollbackTransaction()));
      throw error;
    } finally {
      await Promise.all(transactionContexts.map(({ queryRunner }) => queryRunner.release()));
    }
    return { guid, status: UserRecordStatusCode.REJECTED, reviewedBy: agentGuid, reviewedAt: this.dateService.now(), recordsUpdated: 1 };
  }

  private async startTransactions(): Promise<TransactionContext[]> {
    const transactionContexts: TransactionContext[] = [
      { name: 'legacy', queryRunner: this.legacyDataSource.createQueryRunner() },
      { name: 'admin', queryRunner: this.adminDataSource.createQueryRunner() },
    ];
    await Promise.all(
      transactionContexts.map(async ({ queryRunner }) => {
        await queryRunner.connect();
        await queryRunner.startTransaction();
      }),
    );
    return transactionContexts;
  }

  private runnerFor(transactionContexts: TransactionContext[], name: TransactionContext['name']): QueryRunner {
    return transactionContexts.find((context) => context.name === name).queryRunner;
  }

  // Copies the reviewed record's data onto every row of the user, so all of them show what the agent approved.
  private async setUserRecordManualData(transactionContexts: TransactionContext[], userRecords: UserRecord[], agentData: Record<string, unknown>): Promise<void> {
    const repository = this.runnerFor(transactionContexts, 'legacy').manager.getRepository(UserRecord);
    for (const userRecord of userRecords) {
      const row = await repository.findOne({ where: { guid: userRecord.guid } });
      const merged = { ...row.data, ...agentData };
      const normalized = this.userRecordDataTransformer.normalize(merged);
      const manualData = await this.kmsService.encryptString(JSON.stringify(normalized));
      await repository.save({ ...row, manualData, updatedAt: this.dateService.now() });
    }
  }

  private async saveDecision(queryRunner: QueryRunner, agentGuid: string, guid: string, decision: string, reason?: string): Promise<void> {
    await queryRunner.manager.getRepository(ManualReviewDecision).save({
      recordGuid: guid,
      agentGuid,
      decision,
      reason,
      correlationId: this.requestContextService.getCorrelationId(),
      createdAt: this.dateService.now(),
    });
  }
}
