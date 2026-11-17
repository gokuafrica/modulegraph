import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('manual_review_decisions')
export class ManualReviewDecision {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'record_guid', length: 36 })
  recordGuid: string;

  @Column({ name: 'agent_guid', length: 36 })
  agentGuid: string;

  @Column({ length: 32 })
  decision: string;

  @Column({ type: 'text', nullable: true })
  reason: string;

  @Column({ name: 'correlation_id', length: 64 })
  correlationId: string;

  @Column({ name: 'created_at' })
  createdAt: Date;
}
