import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { DailyStoreMetricRow, NewDailyStoreMetric, dailyStoreMetrics } from '@/db/schema/reports';

import type { DashboardTrendPoint } from '../types/report.types';

@Injectable()
export class DailyStoreMetricsRepository extends BaseRepository<
  typeof dailyStoreMetrics,
  DailyStoreMetricRow,
  NewDailyStoreMetric,
  Partial<NewDailyStoreMetric>
> {
  constructor(db: DbService) {
    super(db.getDb(), dailyStoreMetrics, 'daily_store_metrics');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<DailyStoreMetricRow | null> {
    const [row] = await this.db
      .select()
      .from(dailyStoreMetrics)
      .where(and(eq(dailyStoreMetrics.id, id), eq(dailyStoreMetrics.tenantId, tenantId)))
      .limit(1);
    return (row as DailyStoreMetricRow | undefined) ?? null;
  }

  async findByStoreAndDate(storeId: string, date: Date): Promise<DailyStoreMetricRow | null> {
    const [row] = await this.db
      .select()
      .from(dailyStoreMetrics)
      .where(and(eq(dailyStoreMetrics.storeId, storeId), eq(dailyStoreMetrics.date, date)))
      .limit(1);
    return (row as DailyStoreMetricRow | undefined) ?? null;
  }

  /**
   * Idempotent upsert keyed on `(storeId, date)`. Only mutating
   * fields are updated; `created_by`/`updated_at` round-trip through
   * the trigger-free Drizzle path.
   */
  async upsert(data: NewDailyStoreMetric, tx?: Transaction): Promise<DailyStoreMetricRow> {
    const scope = tx ?? this.db;
    const [row] = (await scope
      .insert(dailyStoreMetrics)
      .values(data)
      .onConflictDoUpdate({
        target: [dailyStoreMetrics.storeId, dailyStoreMetrics.date],
        set: {
          totalScans: data.totalScans ?? 0,
          uniqueProducts: data.uniqueProducts ?? 0,
          matchedScans: data.matchedScans ?? 0,
          unmatchedScans: data.unmatchedScans ?? 0,
          sessionsStarted: data.sessionsStarted ?? 0,
          sessionsCompleted: data.sessionsCompleted ?? 0,
          expiryRecordsAdded: data.expiryRecordsAdded ?? 0,
          expiredItems: data.expiredItems ?? 0,
          nearExpiryItems: data.nearExpiryItems ?? 0,
          alertsGenerated: data.alertsGenerated ?? 0,
          alertsResolved: data.alertsResolved ?? 0,
          tasksCreated: data.tasksCreated ?? 0,
          tasksCompleted: data.tasksCompleted ?? 0,
          tasksOverdue: data.tasksOverdue ?? 0,
          averageTaskMinutes: data.averageTaskMinutes ?? null,
          activeUsers: data.activeUsers ?? 0,
          metadata: data.metadata ?? {},
          updatedAt: new Date(),
        },
      })
      .returning()) as DailyStoreMetricRow[];
    return row;
  }

  async listForStoreRange(
    tenantId: string,
    storeId: string,
    from: Date,
    to: Date,
  ): Promise<DailyStoreMetricRow[]> {
    return (await this.db
      .select()
      .from(dailyStoreMetrics)
      .where(
        and(
          eq(dailyStoreMetrics.tenantId, tenantId),
          eq(dailyStoreMetrics.storeId, storeId),
          gte(dailyStoreMetrics.date, from),
          lte(dailyStoreMetrics.date, to),
        ),
      )
      .orderBy(asc(dailyStoreMetrics.date))) as DailyStoreMetricRow[];
  }

  async getTrendPoints(
    tenantId: string,
    storeId: string,
    from: Date,
    to: Date,
  ): Promise<DashboardTrendPoint[]> {
    const rows = await this.listForStoreRange(tenantId, storeId, from, to);
    return rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      scans: r.totalScans,
      expiryAdded: r.expiryRecordsAdded,
      tasksCompleted: r.tasksCompleted,
    }));
  }

  /**
   * Distinct `(tenantId, storeId)` pairs that produced scan / expiry
   * activity inside the supplied window. Used by the daily aggregator
   * so it does not have to scan every store table individually.
   */
  async findActiveStoresInWindow(
    from: Date,
    to: Date,
  ): Promise<Array<{ tenantId: string; storeId: string }>> {
    const result = await this.db.execute<{
      tenant_id: string;
      store_id: string;
    }>(sql`
      SELECT DISTINCT tenant_id, store_id FROM (
        SELECT tenant_id, store_id FROM scan_items
          WHERE scanned_at >= ${from} AND scanned_at < ${to}
        UNION ALL
        SELECT tenant_id, store_id FROM expiry_records
          WHERE created_at >= ${from} AND created_at < ${to}
            AND deleted_at IS NULL
        UNION ALL
        SELECT tenant_id, store_id FROM expiry_alerts
          WHERE created_at >= ${from} AND created_at < ${to}
      ) sources
      WHERE tenant_id IS NOT NULL AND store_id IS NOT NULL
    `);
    const rows = (result as unknown as { rows?: Array<{ tenant_id: string; store_id: string }> })
      .rows;
    return (rows ?? []).map((r) => ({ tenantId: r.tenant_id, storeId: r.store_id }));
  }
}
