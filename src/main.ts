import 'reflect-metadata';
import { PinoLogger } from 'nestjs-pino';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config/config.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await createApp({ config });
  await app.listen(config.port, '0.0.0.0');
  // The effective configuration, without secrets.
  (await app.resolve(PinoLogger)).info(
    {
      port: config.port,
      base_url: config.baseUrl,
      log_level: config.logLevel,
      access_token_ttl_ms: config.auth.accessTokenTtlMs,
      order_reservation_ttl_ms: config.orderReservationTtlMs,
      queue_prefix: config.queuePrefix,
      payments_enabled: config.stripe !== undefined,
      metrics_protected: config.metricsToken !== undefined,
    },
    'app.started',
  );
}

main().catch((err: unknown) => {
  // The logger may not exist yet; this is the one place that writes to stderr.
  process.stderr.write(
    `moda-hub: ${err instanceof ConfigError ? err.message : String((err as Error)?.stack ?? err)}\n`,
  );
  process.exit(1);
});
