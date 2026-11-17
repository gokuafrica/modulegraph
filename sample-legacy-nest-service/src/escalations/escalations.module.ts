import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EscalationsController } from './controllers/escalations.controller';
import { Escalation } from './entity/escalation.entity';
import { EscalationsService } from './services/escalations.service';
import { ManualReviewModule } from '../manual-review/manual-review.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [TypeOrmModule.forFeature([Escalation], 'admin'), ManualReviewModule, NotificationsModule, AuditLogModule],
  controllers: [EscalationsController],
  providers: [EscalationsService],
  exports: [EscalationsService],
})
export class EscalationsModule {}
