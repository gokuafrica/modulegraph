import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RequestContextService } from '../../request-context/services/request-context.service';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly requestContextService: RequestContextService) {}

  use(req: any, res: any, next: () => void) {
    const correlationId = req.headers['x-correlation-id'] || randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    this.requestContextService.run({ correlationId, agentGuid: req.headers['x-agent-guid'] }, next);
  }
}
