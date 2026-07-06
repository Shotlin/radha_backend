import 'reflect-metadata';

// Tag this process so AppModule registers ScheduleModule.forRoot()
// and every @Cron() decorator becomes active. The API and worker
// entrypoints set RADHA_PROCESS to 'api' / 'worker' instead, which
// keeps crons silent there.
process.env.RADHA_PROCESS = 'scheduler';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { ProcessKind } from './common/enums';
import { ConfigService } from './config/config.service';

/**
 * BE-01 → BE-02 Scheduler entry point.
 *
 * Boots a context-only NestJS application that hosts cron-driven jobs.
 * `ScheduleModule.forRoot()` is registered in AppModule so any
 * `@Cron()` decorators added in later phases (BE-30 OHS, BE-39 recall
 * sweep, BE-49 backups, BE-52 badge issue/revoke, BE-54 weekly digest)
 * fire automatically.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const config = app.get(ConfigService);

  // eslint-disable-next-line no-console
  console.info(`[${ProcessKind.Scheduler}] RADHA scheduler started (${config.nodeEnv})`);

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.info(`[${ProcessKind.Scheduler}] received ${signal}, shutting down...`);
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
  console.error('[scheduler] Failed to start:', error);
  process.exit(1);
});
