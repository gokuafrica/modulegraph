import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CommentsService } from './comments.service';
import { Comment } from '../entity/comment.entity';
import { AuditLogService } from '../../audit-log/services/audit-log.service';

describe('CommentsService', () => {
  it('adds a comment and audits it', async () => {
    const repository = { create: jest.fn((c) => c), save: jest.fn(async (c) => ({ id: 12, ...c })) };
    const auditLogService = { record: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [CommentsService, { provide: getRepositoryToken(Comment, 'legacy'), useValue: repository }, { provide: AuditLogService, useValue: auditLogService }],
    }).compile();

    const comment = await moduleRef.get(CommentsService).addComment('6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10', 'a7d3c1e0-5b2f-4e8a-9c61-2f4b8d0e7a13', 'Called the user, address confirmed');

    expect(comment.id).toBe(12);
    expect(auditLogService.record).toHaveBeenCalledWith('6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10', 'COMMENT_ADDED', 'a7d3c1e0-5b2f-4e8a-9c61-2f4b8d0e7a13', { commentId: 12 });
  });
});
