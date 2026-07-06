import { Injectable } from '@nestjs/common';

/**
 * BE-52 — port for "is this tenant on the Pro plan?".
 *
 * Only Pro_Plan tenants are eligible for the RADHA Verified badge
 * (Req 54). The badge module decouples itself from the BE-28
 * subscriptions module behind this port so the cron can reason
 * about plan eligibility without importing the full subscriptions
 * graph (and so the unit tests can mock it trivially).
 *
 * `listProTenantIds()` is what the daily cron iterates over —
 * every Pro tenant is evaluated each cycle. `isPro()` is the
 * single-tenant check used by the verify endpoint as a defence
 * in depth (a tenant whose Pro plan was cancelled mid-cycle
 * should stop returning an issued badge immediately, even if
 * the cron hasn't caught up).
 */
export interface IProTierPort {
  /** Stream of Pro_Plan tenant ids, ordered however the adapter likes. */
  listProTenantIds(): Promise<string[]>;
  /** Single-tenant check. */
  isPro(tenantId: string): Promise<boolean>;
}

export const PRO_TIER_PORT = Symbol('PRO_TIER_PORT');

/**
 * Default no-op stub.
 *
 * Treats every tenant as Pro so the rest of the pipeline can run
 * unblocked in dev/test. Replace with a BE-28-backed adapter that
 * queries `tenant_subscriptions` once that wiring lands.
 */
@Injectable()
export class StubProTierAdapter implements IProTierPort {
  async listProTenantIds(): Promise<string[]> {
    return [];
  }

  async isPro(_tenantId: string): Promise<boolean> {
    return true;
  }
}
