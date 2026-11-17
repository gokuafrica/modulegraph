import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InternalAuthGuard } from '../../common/guards/internal-auth.guard';
import { DailyReportDto } from '../dto/daily-report.dto';
import { ReportsService } from '../services/reports.service';

@ApiTags('reports')
@ApiSecurity('internal')
@UseGuards(InternalAuthGuard)
@Controller('v1/internal/reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('daily')
  @ApiOperation({ summary: 'Daily decisions', description: 'How many records were approved, rejected or corrected on a day.' })
  @ApiResponse({ status: 200, type: DailyReportDto })
  daily(@Query('day') day: string) {
    return this.reportsService.daily(day);
  }
}
