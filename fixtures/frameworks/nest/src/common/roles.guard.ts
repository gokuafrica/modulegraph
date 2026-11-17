import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Roles } from './auth.decorators.ts';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.get(Roles, context.getHandler()) ?? [];
    const req = context.switchToHttp().getRequest<{ user?: { roles: string[] } }>();
    if (roles.length && !roles.some((r) => req.user?.roles.includes(r))) throw new ForbiddenException();
    return true;
  }
}
