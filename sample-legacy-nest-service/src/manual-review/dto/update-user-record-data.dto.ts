import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';

export class UpdateUserRecordDataDto {
  @ApiProperty({ description: 'Fields to correct; other fields keep their value' })
  @IsObject()
  data: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Why the data was corrected' })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class RejectDecisionDto {
  @ApiProperty({ description: 'Why the record was rejected; shown to the user' })
  @IsString()
  reason: string;
}
