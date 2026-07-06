/**
 * Sentry SDK bootstrap (BE-48).
 *
 * Designed to be invoked once at process start — typically the very
 * first thing in `main.api.ts` / `main.worker.ts` / `main.scheduler.ts`,
 * before NestJS instantiates any provider. This module is intentionally
 * decoupled from the NestJS DI container so that:
 *
 *   1. Sentry is wired up *before* anything that might throw (config
 *      loading, DB connections, schema validation), so even crash-on-
 *      boot errors land in Sentry.
 *   2. The `@sentry/node` package can be absent in dev / CI without
 *      breaking the build — the dynamic import is wrapped in a
 *      try/catch and degrades to a no-op.
 *
 * The `beforeSend` hook is a defence-in-depth layer: even if a
 * developer accidentally captures something containing PII (email,
 * mobile, names, Aadhaar, PAN, …), the redactor runs the entire event
 * payload through `redactPII()` (BE-04 redaction rules) before the
 * SDK transmits it.
 */

import { redactPII } from '@/common/utils/redact.utils';

/**
 * Minimal structural type for the Sentry SDK surface we use.
 *
 * Declared locally so the file compiles even when `@sentry/node` is
 * not installed. The real SDK is structurally compatible.
 */
interface SentryClientLike {
  init(options: Record<string, unknown>): void;
  close(timeout?: number): Promise<boolean>;
  captureException(error: unknown): string;
  captureMessage(message: string, level?: string): string;
  setTag(key: string, value: string): void;
  setContext(name: string, context: Record<string, unknown>): void;
  setUser(user: Record<string, unknown> | null): void;
  withScope(cb: (scope: unknown) => void): void;
  addBreadcrumb(breadcrumb: Record<string, unknown>): void;
}

let sentryClient: SentryClientLike | null = null;
let initialized = false;

/**
 * Returns the loaded Sentry SDK reference, or `null` when:
 *   - `initSentry()` has not been called yet,
 *   - `SENTRY_DSN` is unset,
 *   - or `@sentry/node` is not installed.
 *
 * Callers must always handle the null case gracefully.
 */
export function getSentryClient(): SentryClientLike | null {
  return sentryClient;
}

/**
 * Returns true once `initSentry` has been called, regardless of
 * whether Sentry actually loaded. Used by `BudgetWatcherService` and
 * the correlation-id middleware to know whether the bootstrap step
 * was even attempted.
 */
export function isSentryInitialized(): boolean {
  return initialized;
}

interface InitSentryOptions {
  /** Override DSN; defaults to `process.env.SENTRY_DSN`. */
  dsn?: string;
  /** Override env tag; defaults to `process.env.NODE_ENV`. */
  environment?: string;
  /** Override release; defaults to `process.env.APP_VERSION`. */
  release?: string;
  /**
   * Traces sample rate; defaults to env (`SENTRY_TRACES_SAMPLE_RATE`)
   * or `0.1`. Range `[0, 1]`.
   */
  tracesSampleRate?: number;
  /** Optional callback invoked on every captured event for budget tracking. */
  onEventCaptured?: () => void;
}

/**
 * Initialise the Sentry SDK.
 *
 * No-op when:
 *   - `dsn` (or `process.env.SENTRY_DSN`) is empty / undefined,
 *   - the `@sentry/node` package cannot be loaded.
 *
 * Returns the SDK reference on success, or `null` otherwise. Always
 * resolves; never throws.
 */
export async function initSentry(options: InitSentryOptions = {}): Promise<SentryClientLike | null> {
  initialized = true;

  const dsn = options.dsn ?? process.env.SENTRY_DSN;
  if (!dsn || dsn.length === 0) {
    return null;
  }

  let sentry: SentryClientLike;
  try {
    // Dynamic import keeps `@sentry/node` an optional runtime
    // dependency — `pnpm install` in dev environments without
    // observability infra still succeeds.
    sentry = (await import('@sentry/node')) as unknown as SentryClientLike;
  } catch {
    // SDK not installed; silently degrade to no-op.
    return null;
  }

  const environment = options.environment ?? process.env.NODE_ENV ?? 'development';
  const release = options.release ?? process.env.APP_VERSION ?? '1.0.0';
  const tracesSampleRate =
    options.tracesSampleRate ??
    (() => {
      const raw = process.env.SENTRY_TRACES_SAMPLE_RATE;
      const parsed = raw === undefined ? NaN : Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
      return 0.1;
    })();

  sentry.init({
    dsn,
    environment,
    release,
    tracesSampleRate,
    /**
     * Defence-in-depth PII scrubber. Runs after request body parsing
     * but before SDK transport. Strips known sensitive fields
     * (password, otp, mobile, email, …) recursively from the entire
     * event envelope.
     */
    beforeSend: (event: Record<string, unknown>) => {
      try {
        if (options.onEventCaptured) options.onEventCaptured();
        return redactPII(event);
      } catch {
        // Even if scrubbing fails, prefer dropping the event over
        // leaking PII.
        return null;
      }
    },
  });

  sentryClient = sentry;
  return sentry;
}

/**
 * Drains pending events and shuts down the Sentry transport. Call
 * during graceful shutdown of any process that called `initSentry`.
 */
export async function shutdownSentry(timeoutMs = 2_000): Promise<void> {
  if (!sentryClient) return;
  try {
    await sentryClient.close(timeoutMs);
  } catch {
    // ignore — we're already shutting down.
  }
  sentryClient = null;
  initialized = false;
}

/** Test-only hook to reset module-level state between specs. */
export function __resetSentryForTests(): void {
  sentryClient = null;
  initialized = false;
}
