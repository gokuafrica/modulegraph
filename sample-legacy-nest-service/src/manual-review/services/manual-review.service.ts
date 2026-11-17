import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { KmsService } from '../../kms/services/kms.service';
import { DateService } from '../../date/services/date.service';
import { RequestContextService } from '../../request-context/services/request-context.service';
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
export class ManualReviewService {
  constructor(
    @InjectDataSource('legacy') private readonly legacyDataSource: DataSource,
    @InjectDataSource('admin') private readonly adminDataSource: DataSource,
    private readonly kmsService: KmsService,
    private readonly dateService: DateService,
    private readonly userRecordService: UserRecordService,
    private readonly requestContextService: RequestContextService,
    private readonly userRecordStatusService: UserRecordStatusService,
    private readonly userRecordDataTransformer: UserRecordDataTransformer,
  ) {}

  async approve(agentGuid: string, guid: string, decision: ApproveDecisionDto): Promise<ManualReviewResultDto> {
    const record = await this.userRecordService.getByGuid(guid);
    if (!record) {
      throw new NotFoundException(`User record ${guid} not found`);
    }
    const userRecords = await this.userRecordService.findAllByUserGuid(record.userGuid);
    const transactionContexts = await this.startTransactions();
    try {
      const manualData = {
        ...record.data,
        ...decision.data,
      };
      const encryptedManualData = await this.kmsService.encryptString(JSON.stringify(this.userRecordDataTransformer.normalize(manualData)));
      await this.setUserRecordManualData(transactionContexts, userRecords, encryptedManualData);
      await this.userRecordStatusService.setStatus(this.runnerFor(transactionContexts, 'legacy'), userRecords, UserRecordStatusCode.APPROVED, agentGuid);
      await this.saveDecision(this.runnerFor(transactionContexts, 'admin'), agentGuid, guid, 'APPROVED', decision.reason);
      await Promise.all(transactionContexts.map(({ queryRunner }) => queryRunner.commitTransaction()));
    } catch (error) {
      await Promise.all(transactionContexts.map(({ queryRunner }) => queryRunner.rollbackTransaction()));
      throw error;
    } finally {
      await Promise.all(transactionContexts.map(({ queryRunner }) => queryRunner.release()));
    }
    return { guid, status: UserRecordStatusCode.APPROVED, reviewedBy: agentGuid, reviewedAt: this.dateService.now(), recordsUpdated: userRecords.length };
  }

  async updateUserRecordData(agentGuid: string, guid: string, dto: UpdateUserRecordDataDto): Promise<ManualReviewResultDto> {
    const record = await this.userRecordService.getByGuid(guid);
    if (!record) {
      throw new NotFoundException(`User record ${guid} not found`);
    }
    const userRecords = await this.userRecordService.findAllByUserGuid(record.userGuid);
    const transactionContexts = await this.startTransactions();
    try {
      const encryptedManualData = await this.kmsService.encryptString(JSON.stringify(this.userRecordDataTransformer.normalize({ ...record.data, ...dto.data })));
      await this.setUserRecordManualData(transactionContexts, userRecords, encryptedManualData);
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
      await Promise.all(transactionContexts.map(({ queryRunner }) => queryRunner.commitTransaction()));
    } catch (error) {
      await Promise.all(transactionContexts.map(({ queryRunner }) => queryRunner.rollbackTransaction()));
      throw error;
    } finally {
      await Promise.all(transactionContexts.map(({ queryRunner }) => queryRunner.release()));
    }
    return { guid, status: UserRecordStatusCode.REJECTED, reviewedBy: agentGuid, reviewedAt: this.dateService.now(), recordsUpdated: 1 };
  }

  async getQueue(page: number, limit: number) {
    const [items, total] = await this.userRecordService.findPendingReview(limit, (page - 1) * limit);
    return { items: items.map((r) => this.userRecordDataTransformer.toDto(r)), total, page };
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
  private async setUserRecordManualData(transactionContexts: TransactionContext[], userRecords: UserRecord[], encryptedManualData: string): Promise<void> {
    const repository = this.runnerFor(transactionContexts, 'legacy').manager.getRepository(UserRecord);
    await Promise.all(
      userRecords.map((userRecord) =>
        repository.update({ guid: userRecord.guid }, { manualData: encryptedManualData, updatedAt: this.dateService.now() }),
      ),
    );
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
