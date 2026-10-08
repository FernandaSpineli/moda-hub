import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { HTTP_METRICS, type HttpMetrics } from '../platform/metrics.js';

/** Times every request, labelled by the matched route pattern (or "unmatched"). */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(@Inject(HTTP_METRICS) private readonly metrics: HttpMetrics) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const stop = this.metrics.requestDuration.startTimer();
    res.on('finish', () => {
      // req.route is the Express route that matched; the base URL holds the
      // global prefix. When no handler matched, req.route is this middleware's
      // own catch-all (*path): such requests (404s, scanners) share one label.
      const path = req.route?.path as string | undefined;
      const route = path && !path.includes('*path') ? `${req.baseUrl}${path}` : 'unmatched';
      stop({ method: req.method, route, status: String(res.statusCode) });
    });
    next();
  }
}
