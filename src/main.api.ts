import 'reflect-metadata';

// Tag this process so AppModule can decide whether to register the
// cron scheduler. Cron jobs must only run on the dedicated scheduler
// process — running them on the API or worker would cause every cron
// to fire 3x in production (3x cost on FCM/Sentry/Cloud Vision +
// data anomalies like 3 weekly digests per consumer).
process.env.RADHA_PROCESS = 'api';

import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import compression from 'compression';
import helmet from 'helmet';
import { Logger as NestPinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { API_DEFAULT_VERSION } from './common/constants';
import { ProcessKind } from './common/enums';
import { ConfigService } from './config/config.service';

/**
 * BE-01 → BE-02 → BE-03 API entry point.
 *
 * Boots the HTTP API, applies security headers, enables URI-based
 * versioning, and registers the global ValidationPipe so DTOs
 * defined in later phases get input validation by default.
 *
 * BE-03 added:
 *   - Pino as the application logger (`app.useLogger`)
 *   - Buffered logs so messages emitted during bootstrap go through
 *     Pino once it's initialised.
 *
 * Helmet, compression, CORS, validation, and versioning order matters —
 * this is the spec-mandated middleware order.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // BE-41: enable raw body buffering so webhook controllers
    // (e.g. AffiliateController.recordRevenue) can verify partner
    // HMAC signatures against the unparsed payload.
    rawBody: true,
  });

  // Replace Nest's default Logger with the structured Pino logger.
  app.useLogger(app.get(NestPinoLogger));

  const config = app.get(ConfigService);
  const cors = config.cors;

  app.use(helmet());
  app.use(compression());

  app.enableCors({
    origin: cors.origins.includes('*') ? '*' : cors.origins,
    credentials: cors.credentials,
    methods: cors.methods,
    allowedHeaders: cors.allowedHeaders,
    exposedHeaders: cors.exposedHeaders,
    maxAge: cors.maxAge,
  });

  app.setGlobalPrefix(config.apiPrefix);

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: API_DEFAULT_VERSION,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.enableShutdownHooks();

  await app.listen(config.port);

  // eslint-disable-next-line no-console
  console.info(
    `[${ProcessKind.Api}] RADHA API listening on http://localhost:${config.port}/${config.apiPrefix}/v${API_DEFAULT_VERSION} (${config.nodeEnv})`,
  );
}

bootstrap().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[api] Failed to start:', error);
  process.exit(1);
});
