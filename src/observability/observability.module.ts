import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';

import { AuditLogService } from './audit-log.service';
import { AUDIT_LOG_SERVICE } from './audit-log.types';
import { ERROR_TRACKING_SERVICE, IErrorTrackingService } from './error-tracking.types';
import { MetricsService } from './metrics.service';
import { CorrelationIdMiddleware } from './middleware/correlation-id.middleware';
import { NoopErrorTrackingService } from './noop-error-tracking.service';
import { SentryService } from './sentry.service';
import { BudgetWatcherService } from './services/budget-watcher.service';

import { ConfigService } from '@/config/config.service';

/**
 * Wires up the observability surface.
 *
 *   BE-04
 *   - `IErrorTrackingService` (Sentry when DSN is set, no-op otherwise)
 *   - `IAuditLogService` (structured log today, DB-backed in BE-05)
 *   - `MetricsService` (structured log today, OTel via BE-48 bootstrap)
 *
 *   BE-48
 *   - `BudgetWatcherService` — daily Sentry-quota check (`@Cron`).
 *   - `CorrelationIdMiddleware` — cross-system `X-Correlation-Id`
 *     propagation onto CLS, Sentry scope, and OTel spans.
 *
 * Bootstrap (`initSentry`, `initOtel`, `shutdownSentry`,
 * `shutdownOtel`) is intentionally NOT wired here — the integrator
 * calls them from `main.api.ts` / `main.worker.ts` /
 * `main.scheduler.ts` *before* `NestFactory.create*`, so even
 * crash-on-boot errors are captured.
 */
@Global()
@Module({
  providers: [
    SentryService,
    NoopErrorTrackingService,
    {
      provide: ERROR_TRACKING_SERVICE,
      inject: [ConfigService, SentryService, NoopErrorTrackingService],
      useFactory: (
        config: ConfigService,
        sentry: SentryService,
        noop: NoopErrorTrackingService,
      ): IErrorTrackingService => (config.observability.sentryDsn ? sentry : noop),
    },
    AuditLogService,
    {
      provide: AUDIT_LOG_SERVICE,
      useExisting: AuditLogService,
    },
    MetricsService,
    BudgetWatcherService,
  ],
  exports: [
    ERROR_TRACKING_SERVICE,
    SentryService,
    AUDIT_LOG_SERVICE,
    AuditLogService,
    MetricsService,
    BudgetWatcherService,
  ],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
