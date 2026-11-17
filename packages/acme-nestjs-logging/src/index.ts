import { Inject, Injectable, Module, type DynamicModule, type LoggerService } from '@nestjs/common';

export const LOGGING_OPTIONS = 'ACME_LOGGING_OPTIONS';

export interface LoggingOptions {
  service: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
}

/** Structured JSON lines on stdout, picked up by the log shipper. */
@Injectable()
export class AcmeLogger implements LoggerService {
  constructor(@Inject(LOGGING_OPTIONS) private readonly options: LoggingOptions) {}

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }

  log(message: string, context?: string): void {
    this.write('info', message, { context });
  }

  warn(message: string, context?: Record<string, unknown> | string): void {
    this.write('warn', message, typeof context === 'string' ? { context } : context);
  }

  error(message: string, trace?: unknown, context?: unknown): void {
    this.write('error', message, { trace, context });
  }

  private write(level: string, message: string, context?: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify({ level, service: this.options.service, message, ...context, time: new Date().toISOString() })}\n`);
  }
}

@Module({})
export class AcmeLoggerModule {
  static forRoot(options: LoggingOptions): DynamicModule {
    return { module: AcmeLoggerModule, global: true, providers: [{ provide: LOGGING_OPTIONS, useValue: options }, AcmeLogger], exports: [AcmeLogger] };
  }
}
