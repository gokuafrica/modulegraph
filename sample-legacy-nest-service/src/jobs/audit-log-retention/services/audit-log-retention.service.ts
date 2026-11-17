import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { AcmeLogger } from '@acme/nestjs-logging';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { AuditLogEntry } from '../../../audit-log/entity/audit-log-entry.entity';

const RETENTION_DAYS = 400;

@Injectable()
export class AuditLogRetentionService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(AuditLogEntry, 'admin') private readonly auditLogRepository: Repository<AuditLogEntry>,
    private readonly logger: AcmeLogger,
  ) {}

  async onApplicationBootstrap() {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600_000);
    const result = await this.auditLogRepository.delete({ createdAt: LessThan(cutoff) });
    this.logger.info('audit log retention finished', { deleted: result.affected });
  }
}
