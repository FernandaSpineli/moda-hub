import 'reflect-metadata';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config/config.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await createApp({ config });
  await app.listen(config.port, '0.0.0.0');
}

main().catch((err: unknown) => {
  // The logger may not exist yet; this is the one place that writes to stderr.
  process.stderr.write(
    `moda-hub: ${err instanceof ConfigError ? err.message : String((err as Error)?.stack ?? err)}\n`,
  );
  process.exit(1);
});
