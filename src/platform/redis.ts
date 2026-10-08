import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/config.js';

export const REDIS = Symbol('REDIS');

/** Connects to Redis at startup and fails the boot if it is unreachable. */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG, PinoLogger],
      useFactory: async (config: AppConfig, logger: PinoLogger) => {
        const redis = new Redis(config.redisUrl.reveal(), { lazyConnect: true, connectTimeout: 5_000 });
        // ioredis reconnects on its own; log instead of emitting unhandled errors.
        redis.on('error', (err) => logger.warn({ reason: err.message }, 'redis.client.error'));
        await redis.connect();
        return redis;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    // quit() waits for pending replies, and for a reconnect if the server is
    // gone, which would stall shutdown until the orchestrator kills us.
    if (this.redis.status === 'ready') await this.redis.quit();
    else this.redis.disconnect();
  }
}
