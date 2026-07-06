import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

import { ConfigService } from './config.service';
import { validateEnv } from './env.validation';

/**
 * Custom configuration module for the RADHA backend.
 *
 *   1. Wraps `@nestjs/config`'s `ConfigModule` and registers our Zod
 *      validator (`validateEnv`) so the process fails fast on bad input.
 *   2. Exposes our typed `ConfigService` globally; consumers should
 *      depend on this class, not the underlying NestConfigService or
 *      `process.env`.
 *
 * Env file resolution order matches the BE-02 spec:
 *   `.env.local` → `.env.${NODE_ENV}` → `.env`
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', `.env.${process.env.NODE_ENV ?? 'development'}`, '.env'],
      validate: validateEnv,
      cache: true,
      expandVariables: true,
    }),
  ],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class AppConfigModule {}
