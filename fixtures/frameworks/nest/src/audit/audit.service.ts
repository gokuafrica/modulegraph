import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Column, Entity, PrimaryGeneratedColumn, Repository } from 'typeorm';

@Entity('audit_log')
export class AuditEntry {
  @PrimaryGeneratedColumn() id: number;
  @Column() action: string;
  @Column() subject: string;
}

@Injectable()
export class AuditService {
  constructor(@InjectRepository(AuditEntry) private readonly entries: Repository<AuditEntry>) {}

  async record(action: string, subject: string): Promise<void> {
    await this.entries.insert({ action, subject });
  }
}
