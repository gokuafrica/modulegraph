import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('review_assignments')
export class Assignment {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'record_guid', length: 36 })
  recordGuid: string;

  @Column({ name: 'agent_guid', length: 36 })
  agentGuid: string;

  @Column({ name: 'assigned_at' })
  assignedAt: Date;

  @Column({ name: 'closed_at', nullable: true })
  closedAt: Date;
}
