import { Global, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

import { ConfigService } from '@/config/config.service';
import { AppConfigModule } from '@/config/config.module';

import { LoggerService } from './logger.service';

/**
 * Wires up `nestjs-pino` (HTTP request logging) and exposes our
 * higher-level `LoggerService` to the rest of the application.
 *
 * Pino is configured via the typed `ConfigService` so log level,
 * format (json vs pretty), and per-key redaction stay consistent
 * with the rest of the platform.
 */
@Global()
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.logging.level,
          transport:
            config.logging.format === 'pretty'
              ? {
                  target: 'pino-pretty',
                  options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
                }
              : undefined,
          customProps: () => ({ service: config.appName }),
          serializers: {
            req: (req) => ({
              id: req.id,
              method: req.method,
              url: req.url,
              userAgent: req.headers?.['user-agent'],
            }),
            res: (res) => ({ statusCode: res.statusCode }),
          },
          redact: {
            // PII / secret fields. Wildcards (`*.x`) match any path
            // segment so nested objects (req.body.user.password,
            // res.payload.user.email, ...) are also covered.
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              '*.password',
              '*.passwordHash',
              '*.otp',
              '*.otpHash',
              '*.phone',
              '*.email',
              '*.token',
              '*.refreshToken',
              '*.idToken',
              '*.aadhaar',
              '*.pan',
              '*.address',
              '*.cardNumber',
              '*.cvv',
              ...config.logging.redactKeys.map((k) => `*.${k}`),
            ],
            censor: '[REDACTED]',
          },
        },
      }),
    }),
  ],
  providers: [LoggerService],
  exports: [LoggerService, PinoLoggerModule],
})
export class LoggerModule {}
