import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const AgentGuid = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest();
  return request.headers['x-agent-guid'];
});
