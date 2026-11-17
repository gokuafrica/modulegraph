import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('escalations')
export class Escalation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'record_guid', length: 36 })
  recordGuid: string;

  @Column({ length: 255 })
  reason: string;

  @Column({ name: 'opened_by', length: 36 })
  openedBy: string;

  @Column({ name: 'resolved_by', length: 36, nullable: true })
  resolvedBy: string;

  @Column({ length: 16, default: 'OPEN' })
  state: 'OPEN' | 'RESOLVED';
}
