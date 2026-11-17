import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DailyReportDto } from '../dto/daily-report.dto';

@Injectable()
export class ReportsService {
  constructor(@InjectDataSource('admin') private readonly adminDataSource: DataSource) {}

  async daily(day: string): Promise<DailyReportDto> {
    const rows: { decision: string; total: string }[] = await this.adminDataSource.query(
      'SELECT decision, COUNT(*) AS total FROM manual_review_decisions WHERE DATE(created_at) = ? GROUP BY decision',
      [day],
    );
    return { day, decisions: Object.fromEntries(rows.map((r) => [r.decision, Number(r.total)])) };
  }
}
