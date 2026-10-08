import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

interface RequestContext {
  /** The request (or job) that caused the current work, for tracing. */
  correlationId: () => string | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The correlation ID of the request or job being handled, if any. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId();
}

/** Runs fn with a correlation ID, e.g. while a worker processes a job. */
export function withCorrelationId<T>(correlationId: string | undefined, fn: () => T): T {
  return storage.run({ correlationId: () => correlationId }, fn);
}

/**
 * Makes the request ID available anywhere in the request's async call
 * chain, so code deep in a service (the outbox, for one) can record it
 * without every layer passing it along. pino-http assigns req.id; it is
 * read lazily in case that middleware runs after this one.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request & { id?: unknown }, _res: Response, next: NextFunction): void {
    storage.run({ correlationId: () => (typeof req.id === 'string' ? req.id : undefined) }, next);
  }
}
