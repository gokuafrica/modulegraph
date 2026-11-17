import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InternalAuthGuard } from '../../common/guards/internal-auth.guard';
import { AuditLogEntryDto } from '../dto/audit-log-entry.dto';
import { AuditLogService } from '../services/audit-log.service';

@ApiTags('audit-log')
@ApiSecurity('internal')
@UseGuards(InternalAuthGuard)
@Controller('v1/internal/audit-log')
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get(':recordGuid')
  @ApiOperation({ summary: 'Audit trail', description: 'Everything agents and the system did to a record, newest first (at most 200 entries).' })
  @ApiResponse({ status: 200, type: [AuditLogEntryDto] })
  getAuditTrail(@Param('recordGuid') recordGuid: string) {
    return this.auditLogService.findByRecord(recordGuid);
  }
}
