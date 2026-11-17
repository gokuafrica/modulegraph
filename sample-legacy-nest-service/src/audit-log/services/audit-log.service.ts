import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLogEntry } from '../entity/audit-log-entry.entity';

@Injectable()
export class AuditLogService {
  constructor(@InjectRepository(AuditLogEntry, 'admin') private readonly auditLogRepository: Repository<AuditLogEntry>) {}

  async record(recordGuid: string, action: string, actorGuid: string, details?: Record<string, unknown>): Promise<void> {
    await this.auditLogRepository.insert({ recordGuid, action, actorGuid, details });
  }

  findByRecord(recordGuid: string): Promise<AuditLogEntry[]> {
    return this.auditLogRepository.find({ where: { recordGuid }, order: { createdAt: 'DESC' }, take: 200 });
  }
}
