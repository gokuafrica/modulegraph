import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AssignDto {
  @ApiProperty({ description: 'Agent who takes the record' })
  @IsUUID()
  agentGuid: string;
}
