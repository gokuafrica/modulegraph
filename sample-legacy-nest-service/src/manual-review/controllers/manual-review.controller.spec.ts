import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ManualReviewController } from './manual-review.controller';
import { ManualReviewService } from '../services/manual-review.service';
import { UserRecordStatusCode } from '../../user-records/user-record-status.enum';

describe('ManualReviewController', () => {
  let controller: ManualReviewController;
  const manualReviewService = {
    approve: jest.fn(async (agentGuid: string, guid: string) => ({ guid, status: UserRecordStatusCode.APPROVED, reviewedBy: agentGuid, reviewedAt: new Date('2026-03-02T10:15:00.000Z'), recordsUpdated: 2 })),
    updateUserRecordData: jest.fn(),
    reject: jest.fn(),
    getQueue: jest.fn(async () => ({ items: [], total: 0, page: 1 })),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ManualReviewController],
      providers: [{ provide: ManualReviewService, useValue: manualReviewService }, { provide: ConfigService, useValue: { get: () => 'test-key' } }],
    }).compile();
    controller = moduleRef.get(ManualReviewController);
  });

  it('approves with the agent from the header', async () => {
    const result = await controller.approveUserRecord('6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10', { data: { firstName: 'Ana' }, checklist: { documentChecked: true, identityConfirmed: true } }, 'a7d3c1e0-5b2f-4e8a-9c61-2f4b8d0e7a13');

    expect(manualReviewService.approve).toHaveBeenCalledWith('a7d3c1e0-5b2f-4e8a-9c61-2f4b8d0e7a13', '6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10', expect.objectContaining({ data: { firstName: 'Ana' } }));
    expect(result.status).toBe(UserRecordStatusCode.APPROVED);
  });

  it('returns the review queue', async () => {
    await expect(controller.getQueue({ page: 1, limit: 25 })).resolves.toEqual({ items: [], total: 0, page: 1 });
  });
});
