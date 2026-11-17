import { Controller, Get, Module, Post } from '@nestjs/common';
import { Roles } from '../common/auth.decorators.ts';
import { ReportsService } from './reports.service.ts';

/** Mounted under /admin by RouterModule in AppModule. */
@Controller('reports')
@Roles(['admin'])
export class AdminController {
  constructor(private readonly reports: ReportsService) {}

  @Get('daily')
  daily(): Promise<{ day: string; total: number }[]> {
    return this.reports.daily();
  }

  @Post('purge')
  purge(): Promise<void> {
    return this.reports.purgeCancelled();
  }
}

@Module({ controllers: [AdminController], providers: [ReportsService] })
export class AdminModule {}
