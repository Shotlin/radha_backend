import type { ISubscriptionsService } from './subscription.types';

/**
 * BE-28 — Cross-module DI tokens.
 *
 * Mirrors the BE-26 `INVENTORY_SERVICE_TOKEN` pattern: any phase
 * that consumes the subscription service does so via this Symbol so
 * (a) the import graph stays acyclic and (b) tests can substitute a
 * stub without reaching into NestJS internals.
 *
 * BE-29 (Audit Logs Aggregation), BE-30 (OHS analytics), and the
 * Owner Dashboard (BE-31) all import this token — never the
 * concrete `SubscriptionsService` class.
 */
export const SUBSCRIPTIONS_SERVICE_TOKEN = Symbol('SUBSCRIPTIONS_SERVICE_TOKEN');

export type ISubscriptionsServiceContract = ISubscriptionsService;
