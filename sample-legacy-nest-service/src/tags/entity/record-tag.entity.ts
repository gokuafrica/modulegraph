import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('record_tags')
export class RecordTag {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'record_guid', length: 36 })
  recordGuid: string;

  @Column({ length: 64 })
  tag: string;
}
