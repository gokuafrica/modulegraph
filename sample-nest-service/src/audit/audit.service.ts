import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Repository } from 'typeorm';

@Entity('audit_log')
export class AuditEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  action: string;

  @Column()
  subject: string;

  @Column('jsonb')
  details: Record<string, string>;

  @CreateDateColumn()
  at: Date;
}

/** Audit trail for money and status changes (compliance reads it, nobody edits it). */
@Injectable()
export class AuditService {
  constructor(@InjectRepository(AuditEntry) private readonly log: Repository<AuditEntry>) {}

  async record(action: string, subject: string, details: Record<string, string> = {}): Promise<void> {
    await this.log.insert({ action, subject, details });
  }
}
