import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EscalationsService } from './escalations.service';
import { Escalation } from '../entity/escalation.entity';
import { ManualReviewService } from '../../manual-review/services/manual-review.service';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { AuditLogService } from '../../audit-log/services/audit-log.service';

describe('EscalationsService', () => {
  let service: EscalationsService;
  const repository = {
    findOne: jest.fn(async () => ({ id: 77, recordGuid: '6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10', reason: 'document looks edited', openedBy: 'a7d3c1e0-5b2f-4e8a-9c61-2f4b8d0e7a13', state: 'OPEN' })),
    update: jest.fn(),
    save: jest.fn(async (e) => ({ id: 78, ...e })),
  };
  const manualReviewService = { approveUserRecord: jest.fn() };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        EscalationsService,
        { provide: getRepositoryToken(Escalation, 'admin'), useValue: repository },
        { provide: ManualReviewService, useValue: manualReviewService },
        { provide: NotificationsService, useValue: { notifyEscalation: jest.fn() } },
        { provide: AuditLogService, useValue: { record: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(EscalationsService);
  });

  it('approves the record when the senior agent approves', async () => {
    const decision = { data: { countryOfBirth: 'prt' }, checklist: { documentChecked: true, identityConfirmed: true }, reason: 'senior check ok' };
    const result = await service.resolve(77, 'f0e1d2c3-b4a5-4697-8899-aabbccddeeff', { outcome: 'APPROVE', decision });

    expect(manualReviewService.approveUserRecord).toHaveBeenCalledWith('f0e1d2c3-b4a5-4697-8899-aabbccddeeff', '6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10', decision);
    expect(result.state).toBe('RESOLVED');
  });

  it('opens an escalation and notifies', async () => {
    const result = await service.open('6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10', 'document looks edited', 'a7d3c1e0-5b2f-4e8a-9c61-2f4b8d0e7a13');
    expect(result.id).toBe(78);
  });
});
