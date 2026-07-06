import { Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lt, lte } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  NewTenantSubscription,
  TenantSubscriptionRow,
  tenantSubscriptions,
} from '@/db/schema/tenant-subscriptions';

/**
 * BE-28 — `tenant_subscriptions` data access.
 *
 * Augmentations:
 *   - `findByTenant`           — single-tenant read.
 *   - `findExpiringTrials`     — trials whose `trial_ends_at` has
 *     elapsed; used by the trial-expiry cron.
 *   - `findTrialsExpiringIn`   — for the 7/3/1-day reminder
 *     notifications (cron job).
 *   - `findRenewalsDue`        — for the renewal cron.
 *   - `updateStatusGuarded`    — optimistic state guard for
 *     concurrent upgrade/cancel attempts.
 */
@Injectable()
export class SubscriptionsRepository extends BaseRepository<
  typeof tenantSubscriptions,
  TenantSubscriptionRow,
  NewTenantSubscription,
  Partial<NewTenantSubscription>
> {
  constructor(db: DbService) {
    super(db.getDb(), tenantSubscriptions, 'tenant_subscriptions');
  }

  async findByTenant(tenantId: string): Promise<TenantSubscriptionRow | null> {
    const [row] = await this.db
      .select()
      .from(tenantSubscriptions)
      .where(eq(tenantSubscriptions.tenantId, tenantId))
      .limit(1);
    return (row as TenantSubscriptionRow | undefined) ?? null;
  }

  /**
   * Trial subs whose trial_ends_at is in the past. The cron flips
   * these to `expired`.
   */
  async findExpiringTrials(now: Date = new Date()): Promise<TenantSubscriptionRow[]> {
    return (await this.db
      .select()
      .from(tenantSubscriptions)
      .where(
        and(eq(tenantSubscriptions.status, 'trial'), lte(tenantSubscriptions.trialEndsAt, now)),
      )) as TenantSubscriptionRow[];
  }

  /**
   * Trial subs whose `trial_ends_at` falls inside the day-bucket
   * `[now + (days-1), now + days)`. Used by the 7/3/1-day reminder
   * cron — granularity is per-day so the cron can run hourly without
   * duplicate-sending.
   */
  async findTrialsExpiringIn(
    days: number,
    now: Date = new Date(),
  ): Promise<TenantSubscriptionRow[]> {
    const lower = new Date(now);
    lower.setDate(lower.getDate() + days - 1);
    const upper = new Date(now);
    upper.setDate(upper.getDate() + days);
    return (await this.db
      .select()
      .from(tenantSubscriptions)
      .where(
        and(
          eq(tenantSubscriptions.status, 'trial'),
          gte(tenantSubscriptions.trialEndsAt, lower),
          lt(tenantSubscriptions.trialEndsAt, upper),
        ),
      )) as TenantSubscriptionRow[];
  }

  /**
   * Subs whose `current_period_end` has elapsed and which are still
   * `active` or `cancelled`. The renewal cron uses this to roll the
   * period forward, apply scheduled downgrades, or expire cancelled
   * subscriptions at end-of-cycle.
   */
  async findRenewalsDue(now: Date = new Date()): Promise<TenantSubscriptionRow[]> {
    return (await this.db
      .select()
      .from(tenantSubscriptions)
      .where(
        and(
          inArray(tenantSubscriptions.status, ['active']),
          lte(tenantSubscriptions.currentPeriodEnd, now),
        ),
      )) as TenantSubscriptionRow[];
  }

  /**
   * Cancelled subs whose `current_period_end` has elapsed — the
   * renewal cron flips these to `expired` to honour the spec's
   * "active until period end" guarantee.
   */
  async findEndOfCycleCancellations(now: Date = new Date()): Promise<TenantSubscriptionRow[]> {
    return (await this.db
      .select()
      .from(tenantSubscriptions)
      .where(
        and(
          eq(tenantSubscriptions.status, 'cancelled'),
          lte(tenantSubscriptions.currentPeriodEnd, now),
        ),
      )) as TenantSubscriptionRow[];
  }

  async updateByTenant(
    tenantId: string,
    patch: Partial<NewTenantSubscription>,
  ): Promise<TenantSubscriptionRow | null> {
    const [row] = await this.db
      .update(tenantSubscriptions)
      .set({ ...patch, updatedAt: new Date() } as never)
      .where(eq(tenantSubscriptions.tenantId, tenantId))
      .returning();
    return (row as TenantSubscriptionRow | undefined) ?? null;
  }

  /**
   * Optimistic state guard: only flip status when the row is in one
   * of `allowedFromStates`. Returns null when the guard rejects so
   * the service can surface a "concurrent change" 409.
   */
  async updateStatusGuarded(
    id: string,
    allowedFromStates: TenantSubscriptionRow['status'][],
    patch: Partial<NewTenantSubscription>,
  ): Promise<TenantSubscriptionRow | null> {
    const [row] = await this.db
      .update(tenantSubscriptions)
      .set({ ...patch, updatedAt: new Date() } as never)
      .where(
        and(eq(tenantSubscriptions.id, id), inArray(tenantSubscriptions.status, allowedFromStates)),
      )
      .returning();
    return (row as TenantSubscriptionRow | undefined) ?? null;
  }
}
