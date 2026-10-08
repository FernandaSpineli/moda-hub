import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Registry } from '@prometheus-io/client';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { METRICS_REGISTRY, metricsAuthorized } from '../platform/metrics.js';

/** The worker serves no API; this tiny server only answers /health and /metrics. */
@Injectable()
export class WorkerHttpServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private server?: Server;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(METRICS_REGISTRY) private readonly registry: Registry,
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.server = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
      } else if (req.method === 'GET' && req.url === '/metrics') {
        if (!metricsAuthorized(this.config, req.headers.authorization)) {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': this.registry.contentType }).end(await this.registry.metrics());
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => this.server?.listen(this.config.workerPort, '0.0.0.0', resolve));
    this.logger.info({ port: this.port }, 'worker.http.listening');
  }

  get port(): number {
    return (this.server?.address() as AddressInfo | null)?.port ?? 0;
  }

  async onApplicationShutdown(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }
}
