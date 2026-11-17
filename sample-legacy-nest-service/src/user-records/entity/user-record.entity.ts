import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { UserRecordStatusCode } from '../user-record-status.enum';

@Entity('user_records')
export class UserRecord {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ length: 36 })
  guid: string;

  @Index()
  @Column({ name: 'user_guid', length: 36 })
  userGuid: string;

  @Column({ name: 'record_type', length: 32 })
  recordType: string;

  @Column({ type: 'json' })
  data: Record<string, unknown>;

  @Column({ name: 'manual_data', type: 'text', nullable: true })
  manualData: string | null;

  @Column({ name: 'status_code', type: 'varchar', length: 32, default: UserRecordStatusCode.PENDING_REVIEW })
  statusCode: UserRecordStatusCode;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
