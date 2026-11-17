import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

export class ReviewChecklistDto {
  @ApiProperty({ description: 'The agent compared the data with the uploaded document' })
  documentChecked: boolean;

  @ApiProperty({ description: 'The agent confirmed the user by phone or video' })
  identityConfirmed: boolean;

  @ApiPropertyOptional({ description: 'Free-text notes from the checklist' })
  notes?: string;
}

export class ApproveDecisionDto {
  @ApiProperty({ description: 'Corrected data the agent approved; it replaces the submitted values field by field', example: { firstName: 'Ana', countryOfBirth: 'prt' } })
  @IsObject()
  data: Record<string, unknown>;

  @ApiProperty({ description: 'What the agent checked before approving', type: ReviewChecklistDto })
  @ValidateNested()
  @Type(() => ReviewChecklistDto)
  checklist: ReviewChecklistDto;

  @ApiPropertyOptional({ description: 'Why the agent approved, shown in the audit trail' })
  @IsOptional()
  @IsString()
  reason?: string;
}
