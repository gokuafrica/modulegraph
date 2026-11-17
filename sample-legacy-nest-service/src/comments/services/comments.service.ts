import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Comment } from '../entity/comment.entity';
import { AuditLogService } from '../../audit-log/services/audit-log.service';

@Injectable()
export class CommentsService {
  constructor(
    @InjectRepository(Comment, 'legacy') private readonly commentRepository: Repository<Comment>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async addComment(recordGuid: string, authorGuid: string, body: string): Promise<Comment> {
    const comment = await this.commentRepository.save(this.commentRepository.create({ recordGuid, authorGuid, body }));
    await this.auditLogService.record(recordGuid, 'COMMENT_ADDED', authorGuid, { commentId: comment.id });
    return comment;
  }

  listComments(recordGuid: string): Promise<Comment[]> {
    return this.commentRepository.find({ where: { recordGuid }, order: { createdAt: 'ASC' } });
  }
}
