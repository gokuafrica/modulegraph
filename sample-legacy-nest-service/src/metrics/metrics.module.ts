import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsController } from './controllers/metrics.controller';
import { RequestTimer } from './interceptors/request-timer.interceptor';
import { MetricsService } from './services/metrics.service';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, { provide: APP_INTERCEPTOR, useClass: RequestTimer }],
  exports: [MetricsService],
})
export class MetricsModule {}
