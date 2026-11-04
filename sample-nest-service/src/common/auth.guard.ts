import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    if (!req.headers.authorization?.startsWith('Bearer ')) throw new UnauthorizedException();
    return true;
  }
}
