/**
 * Application-wide enums.
 *
 * Domain enums (UserRole, SubscriptionTier, etc.) live in ``.
 * This file holds enums that are server-internal only.
 */

export enum ProcessKind {
  Api = 'api',
  Worker = 'worker',
  Scheduler = 'scheduler',
}

export enum ServiceHealth {
  Ok = 'ok',
  Degraded = 'degraded',
  Down = 'down',
}
