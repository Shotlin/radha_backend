import 'reflect-metadata';

// Tag this process so AppModule can decide whether to register the
// cron scheduler. Crons must only fire on the scheduler process.
process.env.RADHA_PROCESS = 'worker';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { ProcessKind } from './common/enums';
import { ConfigService } from './config/config.service';

/**
 * BE-01 → BE-02 Worker entry point.
 *
 * Boots a context-only NestJS application (no HTTP listener) so
 * BullMQ consumers and other long-running workloads run independently
 * of the API server. Uses the typed `ConfigService` (BE-02) for env data.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const config = app.get(ConfigService);

  // eslint-disable-next-line no-console
  console.info(`[${ProcessKind.Worker}] RADHA worker started (${config.nodeEnv})`);

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.info(`[${ProcessKind.Worker}] received ${signal}, shutting down...`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

bootstrap().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[worker] Failed to start:', error);
  process.exit(1);
});
