import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('audit_log')
export class AuditLogEntry {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'record_guid', length: 36 })
  recordGuid: string;

  @Column({ name: 'actor_guid', length: 36, nullable: true })
  actorGuid: string;

  @Column({ length: 64 })
  action: string;

  @Column({ type: 'json', nullable: true })
  details: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
