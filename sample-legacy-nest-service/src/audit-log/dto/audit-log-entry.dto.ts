import { ApiProperty } from '@nestjs/swagger';

export class AuditLogEntryDto {
  @ApiProperty({ description: 'What happened, e.g. COMMENT_ADDED, RECORD_APPROVED' })
  action: string;

  @ApiProperty({ description: 'Agent or system that did it' })
  actorGuid: string;

  @ApiProperty({ description: 'When it happened' })
  createdAt: Date;

  @ApiProperty({ description: 'Action-specific details' })
  details: Record<string, unknown>;
}
