import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource('legacy') private readonly legacyDataSource: DataSource,
    @InjectDataSource('admin') private readonly adminDataSource: DataSource,
  ) {}

  @Get()
  async check() {
    await Promise.all([this.legacyDataSource.query('SELECT 1'), this.adminDataSource.query('SELECT 1')]);
    return { status: 'ok' };
  }
}
