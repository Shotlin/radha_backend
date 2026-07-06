import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';

import {
  Breadcrumb,
  ErrorContext,
  ErrorLevel,
  IErrorTrackingService,
} from './error-tracking.types';

type SentryShim = typeof import('@sentry/node');
type SentryEvent = Record<string, unknown> & {
  request?: { data?: unknown; headers?: Record<string, string> };
  extra?: Record<string, unknown>;
};

const PII_FIELDS_TO_SCRUB = [
  'password',
  'otp',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'cookie',
  'secret',
  'aadhaar',
  'pan',
];

const scrubObject = (obj: unknown): unknown => {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(scrubObject);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = PII_FIELDS_TO_SCRUB.some((p) => k.toLowerCase().includes(p))
      ? '[REDACTED]'
      : scrubObject(v);
  }
  return out;
};

/**
 * Sentry-backed implementation of `IErrorTrackingService`.
 *
 * The Sentry SDK is loaded lazily so the package can be installed
 * later (it's optional in BE-01..BE-03). If `@sentry/node` is not
 * available at runtime, the service degrades to a no-op and logs a
 * single warn line at boot.
 *
 * `beforeSend` scrubs sensitive fields from the request payload as a
 * second line of defence — even if a developer accidentally captures
 * a request with a password in the body, Sentry never sees it.
 */
@Injectable()
export class SentryService implements IErrorTrackingService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SentryService.name);
  private sentry: SentryShim | null = null;
  private enabled = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const dsn = this.config.observability.sentryDsn;
    if (!dsn) {
      this.logger.log('Sentry DSN not configured; error tracking disabled.');
      return;
    }

    try {
      this.sentry = (await import('@sentry/node')) as unknown as SentryShim;
    } catch (err) {
      this.logger.warn(
        `@sentry/node not installed (${(err as Error).message}); error tracking disabled.`,
      );
      return;
    }

    this.sentry.init({
      dsn,
      environment: this.config.nodeEnv,
      release: this.config.appVersion,
      tracesSampleRate: this.config.observability.sentryTracesSampleRate,
      beforeSend: ((event: SentryEvent) => {
        if (event.request) {
          if (event.request.data) event.request.data = scrubObject(event.request.data);
          if (event.request.headers)
            event.request.headers = scrubObject(event.request.headers) as Record<string, string>;
        }
        if (event.extra) event.extra = scrubObject(event.extra) as Record<string, unknown>;
        return event;
      }) as never,
    });

    this.enabled = true;
    this.logger.log(
      `Sentry initialised (env=${this.config.nodeEnv}, sample=${this.config.observability.sentryTracesSampleRate})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.enabled && this.sentry) {
      await this.sentry.close(2_000);
    }
  }

  captureException(error: Error, context?: ErrorContext): void {
    if (!this.enabled || !this.sentry) return;
    const sentry = this.sentry;
    sentry.withScope((scope) => {
      this.applyContext(scope, context);
      sentry.captureException(error);
    });
  }

  captureMessage(message: string, level: ErrorLevel, context?: ErrorContext): void {
    if (!this.enabled || !this.sentry) return;
    const sentry = this.sentry;
    sentry.withScope((scope) => {
      scope.setLevel(level as Parameters<typeof scope.setLevel>[0]);
      this.applyContext(scope, context);
      sentry.captureMessage(message);
    });
  }

  setUser(user: { id: string; email?: string; tenantId?: string }): void {
    if (!this.enabled || !this.sentry) return;
    this.sentry.setUser({
      id: user.id,
      ...(user.email ? { email: user.email } : {}),
      ...(user.tenantId ? { tenantId: user.tenantId } : {}),
    });
  }

  clearUser(): void {
    if (!this.enabled || !this.sentry) return;
    this.sentry.setUser(null);
  }

  addBreadcrumb(breadcrumb: Breadcrumb): void {
    if (!this.enabled || !this.sentry) return;
    this.sentry.addBreadcrumb({
      message: breadcrumb.message,
      category: breadcrumb.category,
      level: breadcrumb.level as Parameters<typeof this.sentry.addBreadcrumb>[0]['level'],
      data: breadcrumb.data,
      timestamp: (breadcrumb.timestamp ?? Date.now()) / 1000,
    });
  }

  setTag(key: string, value: string): void {
    if (!this.enabled || !this.sentry) return;
    this.sentry.setTag(key, value);
  }

  setContext(name: string, context: Record<string, unknown>): void {
    if (!this.enabled || !this.sentry) return;
    this.sentry.setContext(name, scrubObject(context) as Record<string, unknown>);
  }

  private applyContext(
    scope: {
      setUser: (u: { id: string }) => void;
      setTag: (k: string, v: string) => void;
      setContext: (k: string, v: Record<string, unknown>) => void;
    },
    context?: ErrorContext,
  ): void {
    if (!context) return;
    if (context.userId) scope.setUser({ id: context.userId });
    if (context.tenantId) scope.setTag('tenantId', context.tenantId);
    if (context.requestId) scope.setTag('requestId', context.requestId);
    if (context.module) scope.setTag('module', context.module);
    if (context.metadata) {
      scope.setContext('metadata', scrubObject(context.metadata) as Record<string, unknown>);
    }
  }
}
