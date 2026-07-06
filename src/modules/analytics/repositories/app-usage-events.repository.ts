import { Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  type AppUsageEventRow,
  appUsageEvents,
  type NewAppUsageEvent,
} from '@/db/schema/app-usage-events';

import type { AppEventType } from '../types/analytics.types';

/**
 * BE-29 — `app_usage_events` data access.
 *
 * Tenant-scoped at the SQL level. Aggregations always filter by
 * `tenant_id` so a user with a stale token can't read another
 * tenant's activity even if the guard layer slips.
 */
@Injectable()
export class AppUsageEventsRepository extends BaseRepository<
  typeof appUsageEvents,
  AppUsageEventRow,
  NewAppUsageEvent,
  Partial<NewAppUsageEvent>
> {
  constructor(db: DbService) {
    super(db.getDb(), appUsageEvents, 'app_usage_events');
  }

  async insertMany(rows: NewAppUsageEvent[]): Promise<number> {
    if (rows.length === 0) return 0;
    const inserted = await this.db
      .insert(appUsageEvents)
      .values(rows)
      .returning({ id: appUsageEvents.id });
    return (inserted as Array<unknown>).length;
  }

  async getUserActivity(
    userId: string,
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<{
    totalEvents: number;
    byType: Record<AppEventType, number>;
    topActions: Array<{ category: string; action: string; count: number }>;
    activeDays: number;
  }> {
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);

    const overview = await this.db.execute(sql`
      SELECT
        COUNT(*)::int                                      AS total_events,
        COUNT(DISTINCT year_month_day)::int                AS active_days,
        COUNT(*) FILTER (WHERE event_type = 'screen_view')::int   AS screen_view,
        COUNT(*) FILTER (WHERE event_type = 'feature_use')::int   AS feature_use,
        COUNT(*) FILTER (WHERE event_type = 'error')::int          AS error,
        COUNT(*) FILTER (WHERE event_type = 'crash')::int          AS crash,
        COUNT(*) FILTER (WHERE event_type = 'performance')::int    AS performance
      FROM app_usage_events
      WHERE tenant_id = ${tenantId}
        AND user_id   = ${userId}
        AND year_month_day BETWEEN ${fromStr} AND ${toStr}
    `);
    const o = this.rows(overview)[0] ?? {};

    const top = await this.db.execute(sql`
      SELECT category, action, COUNT(*)::int AS count
      FROM app_usage_events
      WHERE tenant_id = ${tenantId}
        AND user_id   = ${userId}
        AND year_month_day BETWEEN ${fromStr} AND ${toStr}
      GROUP BY category, action
      ORDER BY count DESC
      LIMIT 10
    `);

    return {
      totalEvents: Number(o.total_events ?? 0),
      activeDays: Number(o.active_days ?? 0),
      byType: {
        screen_view: Number(o.screen_view ?? 0),
        feature_use: Number(o.feature_use ?? 0),
        error: Number(o.error ?? 0),
        crash: Number(o.crash ?? 0),
        performance: Number(o.performance ?? 0),
      },
      topActions: this.rows(top).map((r) => ({
        category: String(r.category ?? ''),
        action: String(r.action ?? ''),
        count: Number(r.count ?? 0),
      })),
    };
  }

  async getTenantActivity(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<{
    totalEvents: number;
    uniqueUsers: number;
    byType: Record<AppEventType, number>;
  }> {
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);

    const result = await this.db.execute(sql`
      SELECT
        COUNT(*)::int                                      AS total_events,
        COUNT(DISTINCT user_id)::int                       AS unique_users,
        COUNT(*) FILTER (WHERE event_type = 'screen_view')::int   AS screen_view,
        COUNT(*) FILTER (WHERE event_type = 'feature_use')::int   AS feature_use,
        COUNT(*) FILTER (WHERE event_type = 'error')::int          AS error,
        COUNT(*) FILTER (WHERE event_type = 'crash')::int          AS crash,
        COUNT(*) FILTER (WHERE event_type = 'performance')::int    AS performance
      FROM app_usage_events
      WHERE tenant_id = ${tenantId}
        AND year_month_day BETWEEN ${fromStr} AND ${toStr}
    `);
    const r = this.rows(result)[0] ?? {};
    return {
      totalEvents: Number(r.total_events ?? 0),
      uniqueUsers: Number(r.unique_users ?? 0),
      byType: {
        screen_view: Number(r.screen_view ?? 0),
        feature_use: Number(r.feature_use ?? 0),
        error: Number(r.error ?? 0),
        crash: Number(r.crash ?? 0),
        performance: Number(r.performance ?? 0),
      },
    };
  }

  async countDistinctUsersOnDay(dateStr: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(distinct user_id)::int` })
      .from(appUsageEvents)
      .where(eq(appUsageEvents.yearMonthDay, dateStr));
    return Number(row?.count ?? 0);
  }

  async countDistinctUsersBetween(from: Date, to: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(distinct user_id)::int` })
      .from(appUsageEvents)
      .where(and(gte(appUsageEvents.createdAt, from), lte(appUsageEvents.createdAt, to)));
    return Number(row?.count ?? 0);
  }

  private rows(result: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
    if (result && typeof result === 'object' && 'rows' in result) {
      const r = (result as { rows?: unknown }).rows;
      if (Array.isArray(r)) return r as Array<Record<string, unknown>>;
    }
    return [];
  }
}
