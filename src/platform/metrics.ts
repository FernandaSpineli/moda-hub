import { timingSafeEqual } from 'node:crypto';
import { Counter, collectDefaultMetrics, Histogram, Registry } from '@prometheus-io/client';
import type { AppConfig } from '../config/config.js';

/**
 * Prometheus metrics. Each process (API, worker) has its own registry with
 * the Node.js runtime metrics and a `service` label.
 */
export function createRegistry(service: 'api' | 'worker'): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry, prefix: 'moda_' });
  return registry;
}

export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');

export function httpMetrics(registry: Registry) {
  return {
    requestDuration: new Histogram({
      name: 'moda_http_request_duration_seconds',
      help: 'HTTP request duration by route pattern, method and status',
      // The route *pattern*, never the raw path, keeps label cardinality bounded.
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
  };
}

export type HttpMetrics = ReturnType<typeof httpMetrics>;
export const HTTP_METRICS = Symbol('HTTP_METRICS');

export function jobMetrics(registry: Registry) {
  return {
    jobs: new Counter({
      name: 'moda_jobs_total',
      help: 'Jobs processed, by queue, job name and outcome',
      labelNames: ['queue', 'name', 'outcome'],
      registers: [registry],
    }),
    duration: new Histogram({
      name: 'moda_job_duration_seconds',
      help: 'Time to process a job successfully',
      labelNames: ['queue', 'name'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
  };
}

export type JobMetrics = ReturnType<typeof jobMetrics>;
export const JOB_METRICS = Symbol('JOB_METRICS');

/** Metrics reveal internals; when a token is configured, require it. */
export function metricsAuthorized(config: AppConfig, authorization: string | undefined): boolean {
  const token = config.metricsToken?.reveal();
  if (!token) return true;
  const given = Buffer.from(authorization?.replace(/^Bearer /i, '') ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
