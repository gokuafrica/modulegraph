import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsString, IsUUID } from 'class-validator';
import { UserRecordStatusCode } from '../user-record-status.enum';

export class UserRecordDto {
  @ApiProperty({ description: 'Public id of the record', example: '6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10' })
  guid: string;

  @ApiProperty({ description: 'The user the record belongs to' })
  userGuid: string;

  @ApiProperty({ description: 'Kind of record: identity, address, employment, …' })
  recordType: string;

  @ApiProperty({ description: 'The data as the user submitted it' })
  data: Record<string, unknown>;

  @ApiProperty({ description: 'Review status', enum: UserRecordStatusCode })
  statusCode: UserRecordStatusCode;

  @ApiPropertyOptional({ description: 'Whether an agent has corrected the data during manual review' })
  hasManualData: boolean;
}

export class CreateUserRecordDto {
  @ApiProperty({ description: 'The user the record belongs to' })
  @IsUUID()
  userGuid: string;

  @ApiProperty({ description: 'Kind of record' })
  @IsString()
  recordType: string;

  @ApiProperty({ description: 'The submitted data' })
  @IsObject()
  data: Record<string, unknown>;
}
