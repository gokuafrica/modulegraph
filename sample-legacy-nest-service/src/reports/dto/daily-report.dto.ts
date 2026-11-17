import { ApiProperty } from '@nestjs/swagger';

export class DailyReportDto {
  @ApiProperty({ description: 'Day of the report (UTC), YYYY-MM-DD' })
  day: string;

  @ApiProperty({ description: 'Decisions per type: APPROVED, REJECTED, DATA_UPDATED' })
  decisions: Record<string, number>;
}
