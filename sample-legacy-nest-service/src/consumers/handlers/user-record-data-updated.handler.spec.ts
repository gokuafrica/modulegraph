import { Test } from '@nestjs/testing';
import { UserRecordDataUpdatedHandler } from './user-record-data-updated.handler';
import { ManualReviewService } from '../../manual-review/services/manual-review.service';

describe('UserRecordDataUpdatedHandler', () => {
  const manualReviewService = { updateUserRecordData: jest.fn(async () => undefined) };
  let handler: UserRecordDataUpdatedHandler;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [UserRecordDataUpdatedHandler, { provide: ManualReviewService, useValue: manualReviewService }],
    }).compile();
    handler = moduleRef.get(UserRecordDataUpdatedHandler);
  });

  it('applies the corrected data sent by review-tools', async () => {
    await handler.handle({
      topic: 'records.user-record-data-updated.v1',
      partition: 2,
      offset: '18234',
      headers: { 'x-correlation-id': 'corr-81aa' },
      value: { guid: 'c2a9e4d1-7b3f-4f0a-8e2d-91b6c5a4f3e2', agentGuid: 'a7d3c1e0-5b2f-4e8a-9c61-2f4b8d0e7a13', data: { employerName: 'Acme Logistics Lda' } },
    });

    expect(manualReviewService.updateUserRecordData).toHaveBeenCalledWith('a7d3c1e0-5b2f-4e8a-9c61-2f4b8d0e7a13', 'c2a9e4d1-7b3f-4f0a-8e2d-91b6c5a4f3e2', { data: { employerName: 'Acme Logistics Lda' }, reason: 'updated by review-tools' });
  });
});
