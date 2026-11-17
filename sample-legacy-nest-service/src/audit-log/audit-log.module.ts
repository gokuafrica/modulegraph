import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogController } from './controllers/audit-log.controller';
import { AuditLogEntry } from './entity/audit-log-entry.entity';
import { AuditLogService } from './services/audit-log.service';
import { AuditEventsPublisher } from './services/audit-events.publisher';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLogEntry], 'admin')],
  controllers: [AuditLogController],
  providers: [AuditLogService, AuditEventsPublisher],
  exports: [AuditLogService, AuditEventsPublisher],
})
export class AuditLogModule {}
