/**
 * Error-tracking abstraction.
 *
 * `ErrorTrackingService` consumers depend on this interface, never on
 * Sentry directly. That keeps Sentry an opt-in dependency: production
 * gets it, local dev / tests get a no-op implementation, and we can
 * swap providers (Bugsnag, Rollbar, self-hosted GlitchTip) without
 * touching consumer code.
 */

export type ErrorLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

export interface ErrorContext {
  userId?: string;
  tenantId?: string;
  requestId?: string;
  module?: string;
  metadata?: Record<string, unknown>;
}

export interface Breadcrumb {
  message: string;
  category: string;
  level: ErrorLevel;
  data?: Record<string, unknown>;
  timestamp?: number;
}

export interface IErrorTrackingService {
  captureException(error: Error, context?: ErrorContext): void;
  captureMessage(message: string, level: ErrorLevel, context?: ErrorContext): void;
  setUser(user: { id: string; email?: string; tenantId?: string }): void;
  clearUser(): void;
  addBreadcrumb(breadcrumb: Breadcrumb): void;
  setTag(key: string, value: string): void;
  setContext(name: string, context: Record<string, unknown>): void;
}

export const ERROR_TRACKING_SERVICE = Symbol('ERROR_TRACKING_SERVICE');
