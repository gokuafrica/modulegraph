import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  correlationId: string;
  agentGuid?: string;
}

@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  run(context: RequestContext, callback: () => void) {
    this.storage.run(context, callback);
  }

  getCorrelationId(): string {
    return this.storage.getStore()?.correlationId ?? 'no-correlation-id';
  }

  getAgentGuid(): string | undefined {
    return this.storage.getStore()?.agentGuid;
  }
}
