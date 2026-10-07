import { ForbiddenException, HttpException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

type HttpRequest = {
  method: string;
  headers: Record<string, string | string[] | undefined>;
};

const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class BrowserWriteGuard implements CanActivate {
  constructor(private readonly allowedOrigin: string) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    if (!writeMethods.has(request.method)) return true;

    if (request.headers.origin !== this.allowedOrigin ||
      request.headers['x-stocksync-request'] !== '1') {
      throw new ForbiddenException();
    }

    const contentType = request.headers['content-type'];
    const hasBody = Number(request.headers['content-length'] ?? 0) > 0 ||
      request.headers['transfer-encoding'] !== undefined;
    if ((hasBody || contentType !== undefined) &&
      (typeof contentType !== 'string' ||
        contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')) {
      throw new HttpException('Unsupported Media Type', 415);
    }

    return true;
  }
}
