import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { MetricsService } from '../services/metrics.service';

const EXCLUDED_PATHS = new Set(['/metrics', '/health', '/api/docs']);

@Injectable()
export class RequestTimer implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const path: string = request.route?.path;
    if (!path || EXCLUDED_PATHS.has(path)) {
      return next.handle();
    }
    const stopTimer = this.metricsService.startRequestTimer(request.method, path);
    this.metricsService.countRequest(request.method, path);
    this.metricsService.trackInFlight(request.method, path, 1);
    return next.handle().pipe(
      tap({
        next: () => this.handleStatusCode(context, request.method, path, stopTimer),
        error: (error) => this.handleError(error, request.method, path, stopTimer),
      }),
    );
  }

  private handleStatusCode(context: ExecutionContext, method: string, path: string, stopTimer: () => number) {
    const status = context.switchToHttp().getResponse().statusCode;
    this.metricsService.observeLatency(method, path, status, stopTimer());
    this.metricsService.handleStatusCode(method, path, status);
    this.metricsService.trackInFlight(method, path, -1);
  }

  private handleError(error: any, method: string, path: string, stopTimer: () => number) {
    const status = error?.status ?? 500;
    this.metricsService.observeLatency(method, path, status, stopTimer());
    this.metricsService.handleStatusCode(method, path, status);
    this.metricsService.countError(method, path, error?.name ?? 'Error');
    this.metricsService.trackInFlight(method, path, -1);
  }
}
