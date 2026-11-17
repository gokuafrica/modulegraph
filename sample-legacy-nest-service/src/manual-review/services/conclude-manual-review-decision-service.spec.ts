import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { loadFixture } from '../../../test/fixtures/load-fixture';
import { TypeORMOutboxService } from '@acme/typeorm-outbox-writer';
import { ConcludeManualReviewDecisionService } from './conclude-manual-review-decision-service';
import { SyncedMessageService } from '../../outbox/services/synced-message.service';
import { KmsService } from '../../kms/services/kms.service';
import { DateService } from '../../date/services/date.service';
import { RequestContextService } from '../../request-context/services/request-context.service';
import { UserRecordService } from '../../user-records/services/user-record.service';
import { UserRecordStatusService } from '../../user-records/services/user-record-status.service';
import { UserRecordDataTransformer } from '../../user-records/services/user-record-data.transformer';
import { UserRecord } from '../../user-records/entity/user-record.entity';
import { UserRecordStatusCode } from '../../user-records/user-record-status.enum';

const fixtures = loadFixture('user-records');
const approveDecision = loadFixture('approve-decision');
const NOW = new Date('2026-03-02T10:15:00.000Z');
const AGENT_GUID = 'a7d3c1e0-5b2f-4e8a-9c61-2f4b8d0e7a13';

function queryRunnerMock(repository: Record<string, jest.Mock>) {
  return {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: { getRepository: jest.fn(() => repository) },
  };
}

describe('ConcludeManualReviewDecisionService', () => {
  let service: ConcludeManualReviewDecisionService;
  let rows: Record<string, UserRecord>;
  let legacyRepository: Record<string, jest.Mock>;
  let adminRepository: Record<string, jest.Mock>;
  let legacyRunner: ReturnType<typeof queryRunnerMock>;
  let adminRunner: ReturnType<typeof queryRunnerMock>;
  const userRecordService = { getByGuid: jest.fn(), getByGuidOrFail: jest.fn(), findAllByUserGuid: jest.fn() };
  const userRecordStatusService = { setStatus: jest.fn() };
  const outboxService = { createOutboxMessage: jest.fn(async () => undefined) };
  const kmsService = { encryptString: jest.fn(async (plaintext: string) => `kms:v1:${Buffer.from(plaintext).toString('base64').slice(0, 24)}`) };

  beforeEach(async () => {
    rows = Object.fromEntries((fixtures.records as UserRecord[]).map((r) => [r.guid, { ...r }]));
    legacyRepository = {
      findOne: jest.fn(async ({ where }) => rows[where.guid] ?? null),
      update: jest.fn(async () => ({ affected: 1 })),
      save: jest.fn(async (entity) => entity),
    };
    adminRepository = { save: jest.fn(async (entity) => ({ id: 901, ...entity })) };
    legacyRunner = queryRunnerMock(legacyRepository);
    adminRunner = queryRunnerMock(adminRepository);
    userRecordService.getByGuid.mockImplementation(async (guid: string) => rows[guid] ?? null);
    userRecordService.findAllByUserGuid.mockImplementation(async (userGuid: string) => Object.values(rows).filter((r) => r.userGuid === userGuid));
    userRecordStatusService.setStatus.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ConcludeManualReviewDecisionService,
        UserRecordDataTransformer,
        SyncedMessageService,
        { provide: TypeORMOutboxService, useValue: outboxService },
        { provide: getDataSourceToken('legacy'), useValue: { createQueryRunner: () => legacyRunner } },
        { provide: getDataSourceToken('admin'), useValue: { createQueryRunner: () => adminRunner } },
        { provide: KmsService, useValue: kmsService },
        { provide: DateService, useValue: { now: () => NOW } },
        { provide: UserRecordService, useValue: userRecordService },
        { provide: UserRecordStatusService, useValue: userRecordStatusService },
        { provide: RequestContextService, useValue: { getCorrelationId: () => 'corr-5f2e9b' } },
      ],
    }).compile();
    service = moduleRef.get(ConcludeManualReviewDecisionService);
  });

  describe('approve', () => {
    it('approves the record and stores the agent data on every record of the user', async () => {
      const result = await service.approve(AGENT_GUID, '6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10', approveDecision);

      expect(result).toEqual({ guid: '6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10', status: UserRecordStatusCode.APPROVED, reviewedBy: AGENT_GUID, reviewedAt: NOW, recordsUpdated: 2 });
      expect(legacyRepository.update).toHaveBeenCalledTimes(2);
      expect(userRecordStatusService.setStatus).toHaveBeenCalledWith(legacyRunner, expect.any(Array), UserRecordStatusCode.APPROVED, AGENT_GUID);
      expect(legacyRunner.commitTransaction).toHaveBeenCalled();
      expect(adminRunner.commitTransaction).toHaveBeenCalled();
      expect(outboxService.createOutboxMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'UserRecordApprovedNotification', aggregateId: '6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10' }), legacyRunner.manager);
    });

    it('throws NotFoundException for an unknown record', async () => {
      await expect(service.approve(AGENT_GUID, '00000000-0000-0000-0000-000000000000', approveDecision)).rejects.toThrow(NotFoundException);
    });

    it('rolls back both transactions when the status cannot be saved', async () => {
      userRecordStatusService.setStatus.mockRejectedValueOnce(new Error('Deadlock found when trying to get lock'));

      await expect(service.approve(AGENT_GUID, '6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10', approveDecision)).rejects.toThrow('Deadlock');
      expect(legacyRunner.rollbackTransaction).toHaveBeenCalled();
      expect(adminRunner.rollbackTransaction).toHaveBeenCalled();
      expect(legacyRunner.release).toHaveBeenCalled();
    });
  });

  describe('correctData', () => {
    it('corrects the data of the user records without changing their status', async () => {
      const result = await service.correctData(AGENT_GUID, 'c2a9e4d1-7b3f-4f0a-8e2d-91b6c5a4f3e2', { data: { addressLine1: ' Rua das Flores 12 ' }, reason: 'typo in street' });

      expect(result.status).toBe(UserRecordStatusCode.PENDING_REVIEW);
      expect(userRecordStatusService.setStatus).not.toHaveBeenCalled();
      expect(kmsService.encryptString).toHaveBeenCalled();
    });
  });
});
