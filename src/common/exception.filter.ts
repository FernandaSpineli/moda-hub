import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { AppError } from './app-error.js';

interface Envelope {
  error: { code: string; message: string; details?: unknown; request_id?: string };
}

const codeByStatus: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'ROUTE_NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'BODY_TOO_LARGE',
  429: 'RATE_LIMITED',
};

/**
 * Turns every error into the API's error envelope. Expected errors keep
 * their code and message; anything unexpected is logged with its stack and
 * answered with a generic 500, so internals never reach the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    logger.setContext('http');
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string }>();
    const res = ctx.getResponse<Response>();
    const { status, body } = this.toEnvelope(exception, req);
    body.error.request_id = typeof req.id === 'string' ? req.id : undefined;
    res.status(status).json(body);
  }

  private toEnvelope(exception: unknown, req: Request): { status: number; body: Envelope } {
    if (exception instanceof AppError) {
      const { status, code, message, details } = exception;
      return { status, body: { error: { code, message, details } } };
    }

    // Nest turns body-parser's SyntaxError into a BadRequestException before
    // any handler runs. Application code never throws BadRequestException
    // (it uses AppError), so on a JSON request this can only be bad JSON.
    if (exception instanceof BadRequestException && req.is('application/json')) {
      return envelope(400, 'INVALID_JSON', 'Request body is not valid JSON');
    }
    if ((exception as { type?: string })?.type === 'entity.too.large') {
      return envelope(413, 'BODY_TOO_LARGE', 'Request body is too large');
    }

    if (exception instanceof HttpException && exception.getStatus() < 500) {
      const status = exception.getStatus();
      const message = status === 404 ? 'Route not found' : exception.message;
      return envelope(status, codeByStatus[status] ?? `HTTP_${status}`, message);
    }

    this.logger.error({ err: exception }, 'http.unhandled_error');
    return envelope(500, 'INTERNAL', 'Internal server error');
  }
}

function envelope(status: number, code: string, message: string) {
  return { status, body: { error: { code, message } } as Envelope };
}
