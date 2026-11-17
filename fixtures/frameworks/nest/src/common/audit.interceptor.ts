import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { type Observable, tap } from 'rxjs';
import { AuditService } from '../audit/audit.service.ts';

/** Records every call to the controllers it is applied to. */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ url: string }>();
    return next.handle().pipe(tap(() => void this.audit.record('request', req.url)));
  }
}
