import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { AppConfig } from '../config/config.js';

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Keeps a well-formed incoming X-Request-ID (so a request can be traced
 * across services) or creates one, and echoes it in the response. Anything
 * else is replaced, so clients cannot inject content into the logs.
 */
export function requestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-request-id'];
  const id =
    typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID().replaceAll('-', '');
  res.setHeader('X-Request-ID', id);
  return id;
}

/**
 * pino-http options. Every line is JSON with an "event" name. Request
 * headers and bodies are never logged, and only the path of the URL is (a
 * query string can carry tokens).
 */
export function loggerParams(config: AppConfig, stream?: DestinationStream): Params {
  return {
    pinoHttp: [
      {
        level: config.logLevel,
        messageKey: 'event',
        base: { service: 'moda-hub', env: config.env },
        formatters: { level: (label) => ({ level: label }) },
        genReqId: requestId,
        // Put request_id on the request's child logger, so business events
        // logged during the request carry it too.
        quietReqLogger: true,
        customAttributeKeys: { reqId: 'request_id', responseTime: 'duration_ms' },
        customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : 'info'),
        customSuccessMessage: () => 'http.request',
        customErrorMessage: () => 'http.request',
        serializers: {
          req: (req: { method: string; url: string; remoteAddress?: string }) => ({
            method: req.method,
            path: req.url.split('?')[0],
            remote_ip: req.remoteAddress,
          }),
          res: (res: { statusCode: number }) => ({ status: res.statusCode }),
        },
        // Defence in depth for anything logged by hand.
        redact: {
          paths: [
            '*.password',
            '*.token',
            '*.refresh_token',
            '*.authorization',
            '*.cookie',
            'password',
            'token',
          ],
          censor: '[REDACTED]',
        },
      },
      ...(stream ? [stream] : []),
    ] as Params['pinoHttp'],
  };
}
