import { ArgumentsHost, Catch, HttpException, HttpStatus } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';

type HttpResponse = {
  status(code: number): HttpResponse;
  json(body: object): void;
};

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const statusCode = exception instanceof HttpException ? exception.getStatus() : 500;
    const response = exception instanceof HttpException ? exception.getResponse() : undefined;
    const detail = typeof response === 'object' && response !== null
      ? response as Record<string, unknown> : undefined;
    const code = statusCode >= 500 ? 'INTERNAL_SERVER_ERROR'
      : typeof detail?.code === 'string' ? detail.code
        : HttpStatus[statusCode] ?? 'HTTP_ERROR';
    const message = statusCode >= 500 ? 'Internal server error'
      : typeof response === 'string' ? response
        : typeof detail?.message === 'string' ? detail.message : 'Request failed';

    host.switchToHttp().getResponse<HttpResponse>()
      .status(statusCode).json({ statusCode, code, message });
  }
}
