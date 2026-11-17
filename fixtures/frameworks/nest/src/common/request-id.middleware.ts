import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: { headers: Record<string, string | undefined> }, _res: unknown, next: () => void): void {
    req.headers['x-request-id'] ??= randomUUID();
    next();
  }
}
