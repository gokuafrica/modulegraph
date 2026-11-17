import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SessionsService } from '../sessions/sessions.service.ts';
import { IS_PUBLIC } from './auth.decorators.ts';

/** Global guard (APP_GUARD): every request needs a live session unless the route is @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const session = await this.sessions.find(req.headers.authorization ?? '');
    if (!session) throw new UnauthorizedException();
    return true;
  }
}
