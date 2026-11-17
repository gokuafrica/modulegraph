import { Test } from '@nestjs/testing';
import { ManualReviewService } from './manual-review.service';
import { ConcludeManualReviewDecisionService } from './conclude-manual-review-decision-service';
import { UserRecordService } from '../../user-records/services/user-record.service';
import { UserRecordDataTransformer } from '../../user-records/services/user-record-data.transformer';
import { UserRecordStatusCode } from '../../user-records/user-record-status.enum';

describe('ManualReviewService', () => {
  let service: ManualReviewService;
  const conclude = {
    approve: jest.fn(async (agentGuid: string, guid: string) => ({ guid, status: UserRecordStatusCode.APPROVED, reviewedBy: agentGuid, reviewedAt: new Date('2026-03-02T10:15:00.000Z'), recordsUpdated: 2 })),
    correctData: jest.fn(),
    reject: jest.fn(),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ManualReviewService,
        UserRecordDataTransformer,
        { provide: ConcludeManualReviewDecisionService, useValue: conclude },
        { provide: UserRecordService, useValue: { findPendingReview: jest.fn(async () => [[], 0]) } },
      ],
    }).compile();
    service = moduleRef.get(ManualReviewService);
  });

  it('hands an approval to the decision service', async () => {
    const result = await service.approveUserRecord('a7d3c1e0-5b2f-4e8a-9c61-2f4b8d0e7a13', '6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10', { data: { firstName: 'Ana' }, checklist: { documentChecked: true, identityConfirmed: true } });

    expect(conclude.approve).toHaveBeenCalledWith('a7d3c1e0-5b2f-4e8a-9c61-2f4b8d0e7a13', '6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10', expect.objectContaining({ data: { firstName: 'Ana' } }));
    expect(result.recordsUpdated).toBe(2);
  });

  it('returns an empty queue page', async () => {
    await expect(service.getQueue(1, 25)).resolves.toEqual({ items: [], total: 0, page: 1 });
  });
});
