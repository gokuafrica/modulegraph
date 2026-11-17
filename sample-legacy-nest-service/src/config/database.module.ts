import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { UserRecord } from '../user-records/entity/user-record.entity';
import { UserRecordStatus } from '../user-records/entity/user-record-status.entity';
import { Comment } from '../comments/entity/comment.entity';
import { ManualReviewDecision } from '../manual-review/entity/manual-review-decision.entity';
import { AuditLogEntry } from '../audit-log/entity/audit-log-entry.entity';
import { Assignment } from '../assignments/entity/assignment.entity';
import { Escalation } from '../escalations/entity/escalation.entity';
import { RecordTag } from '../tags/entity/record-tag.entity';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: 'legacy',
      inject: [ConfigService],
      useFactory: (config: ConfigService): TypeOrmModuleOptions => ({
        type: 'mysql' as const,
        ...config.get<object>('databases.legacy'),
        entities: [UserRecord, UserRecordStatus, Comment],
        synchronize: false,
      }),
    }),
    TypeOrmModule.forRootAsync({
      name: 'admin',
      inject: [ConfigService],
      useFactory: (config: ConfigService): TypeOrmModuleOptions => ({
        type: 'mysql' as const,
        ...config.get<object>('databases.admin'),
        entities: [ManualReviewDecision, AuditLogEntry, Assignment, Escalation, RecordTag],
        synchronize: false,
      }),
    }),
  ],
})
export class DatabaseModule {}
