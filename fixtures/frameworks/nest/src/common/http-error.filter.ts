import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';

@Catch(HttpException)
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{ status(n: number): { json(body: unknown): void } }>();
    res.status(exception.getStatus()).json({ error: exception.message });
  }
}
