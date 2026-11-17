import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { UserRecordStatusCode } from '../user-record-status.enum';

@Entity('user_record_statuses')
export class UserRecordStatus {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'record_guid', length: 36 })
  recordGuid: string;

  @Column({ type: 'varchar', length: 32 })
  status: UserRecordStatusCode;

  @Column({ name: 'changed_by', length: 36, nullable: true })
  changedBy: string;

  @Column({ name: 'changed_at' })
  changedAt: Date;
}
