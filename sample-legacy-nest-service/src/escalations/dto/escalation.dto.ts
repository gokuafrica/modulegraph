import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsString, ValidateNested } from 'class-validator';
import { ApproveDecisionDto } from '../../manual-review/dto/approve-decision.dto';

export class OpenEscalationDto {
  @ApiProperty({ description: 'Why a senior agent has to look at it' })
  @IsString()
  reason: string;
}

export class ResolveEscalationDto {
  @ApiProperty({ description: 'APPROVE applies the senior agent\'s decision; DISMISS sends the record back to the queue', enum: ['APPROVE', 'DISMISS'] })
  @IsIn(['APPROVE', 'DISMISS'])
  outcome: 'APPROVE' | 'DISMISS';

  @ApiProperty({ description: 'The decision to apply when approving', type: ApproveDecisionDto })
  @ValidateNested()
  @Type(() => ApproveDecisionDto)
  decision: ApproveDecisionDto;
}
