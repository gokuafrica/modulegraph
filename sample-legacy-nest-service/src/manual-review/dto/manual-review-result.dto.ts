import { ApiProperty } from '@nestjs/swagger';
import { UserRecordStatusCode } from '../../user-records/user-record-status.enum';

export class ManualReviewResultDto {
  @ApiProperty({ description: 'The reviewed record' })
  guid: string;

  @ApiProperty({ description: 'Status after the review', enum: UserRecordStatusCode })
  status: UserRecordStatusCode;

  @ApiProperty({ description: 'Agent who reviewed it' })
  reviewedBy: string;

  @ApiProperty({ description: 'When the review was saved' })
  reviewedAt: Date;

  @ApiProperty({ description: 'How many of the user\'s records were updated' })
  recordsUpdated: number;
}
