import { Injectable } from '@nestjs/common';

import {
  Breadcrumb,
  ErrorContext,
  ErrorLevel,
  IErrorTrackingService,
} from './error-tracking.types';

/**
 * No-op implementation used when SENTRY_DSN is unset (most local
 * dev) or when the test runner runs without observability wiring.
 *
 * Exists so that consumers can always inject `ERROR_TRACKING_SERVICE`
 * without checking for null / a feature flag at every call site.
 */
@Injectable()
export class NoopErrorTrackingService implements IErrorTrackingService {
  captureException(_error: Error, _context?: ErrorContext): void {
    /* intentionally empty */
  }
  captureMessage(_message: string, _level: ErrorLevel, _context?: ErrorContext): void {
    /* intentionally empty */
  }
  setUser(_user: { id: string }): void {
    /* intentionally empty */
  }
  clearUser(): void {
    /* intentionally empty */
  }
  addBreadcrumb(_breadcrumb: Breadcrumb): void {
    /* intentionally empty */
  }
  setTag(_key: string, _value: string): void {
    /* intentionally empty */
  }
  setContext(_name: string, _context: Record<string, unknown>): void {
    /* intentionally empty */
  }
}
