import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';

import { DailyStoreMetricsRepository } from '../repositories/daily-store-metrics.repository';
import type { AggregationResult } from '../types/report.types';

/**
 * BE-20 — Daily metrics aggregator.
 *
 * Computes one row per `(tenant, store, day)` from the raw event
 * tables and upserts into `daily_store_metrics`. The dashboard then
 * reads pre-aggregated rows for trend points instead of paying for
 * a 24-hour group-by on every request.
 *
 * The job is idempotent: running it twice for the same date produces
 * the same target row because the upsert is keyed on `(store_id, date)`.
 *
 * BE-24 schedules `aggregateForDate(yesterday)` daily at 01:00 UTC.
 * BE-20 ships the function and an admin endpoint so it can be
 * triggered manually for backfills.
 */
@Injectable()
export class MetricsAggregatorService {
  constructor(
    private readonly db: DbService,
    private readonly metricsRepo: DailyStoreMetricsRepository,
    private readonly logger: LoggerService,
  ) {}

  async aggregateForDate(date: Date): Promise<AggregationResult> {
    const start = startOfUtcDay(date);
    const end = startOfUtcDay(addDays(date, 1));
    const dateLabel = start.toISOString().slice(0, 10);

    const stores = await this.metricsRepo.findActiveStoresInWindow(start, end);
    if (stores.length === 0) {
      this.logger.info('reports.aggregator.no-activity', { date: dateLabel });
      return { date: dateLabel, storesProcessed: 0, rowsUpserted: 0 };
    }

    let upserted = 0;
    for (const { tenantId, storeId } of stores) {
      const metrics = await this.collectForStore(tenantId, storeId, start, end);
      await this.metricsRepo.upsert({
        tenantId,
        storeId,
        date: start,
        ...metrics,
      });
      upserted++;
    }

    this.logger.info('reports.aggregator.completed', {
      date: dateLabel,
      storesProcessed: stores.length,
      rowsUpserted: upserted,
    });
    return { date: dateLabel, storesProcessed: stores.length, rowsUpserted: upserted };
  }

  /**
   * Aggregate every gathered metric for a single (tenant, store)
   * over the given UTC window. Six concurrent reads — bounded
   * concurrency keeps a busy aggregator from saturating the pool.
   */
  private async collectForStore(
    tenantId: string,
    storeId: string,
    from: Date,
    to: Date,
  ): Promise<
    Omit<import('@/db/schema/reports').NewDailyStoreMetric, 'tenantId' | 'storeId' | 'date'>
  > {
    const dbConn = this.db.getDb();
    const [scans, sessions, expiry, expiryAlerts, taskStats, activeUsers] = await Promise.all([
      dbConn.execute<{
        total: number;
        unique_products: number;
        matched: number;
        unmatched: number;
      }>(sql`
          SELECT count(*)::int as total,
                 count(DISTINCT ean)::int as unique_products,
                 sum(CASE WHEN ean_match_status = 'matched' THEN 1 ELSE 0 END)::int as matched,
                 sum(CASE WHEN ean_match_status = 'unmatched' THEN 1 ELSE 0 END)::int as unmatched
          FROM scan_items
          WHERE tenant_id = ${tenantId}
            AND store_id = ${storeId}
            AND deleted_at IS NULL
            AND scanned_at >= ${from}
            AND scanned_at < ${to}
        `),
      dbConn.execute<{ started: number; completed: number }>(sql`
          SELECT
            sum(CASE WHEN started_at >= ${from} AND started_at < ${to} THEN 1 ELSE 0 END)::int as started,
            sum(CASE WHEN ended_at IS NOT NULL AND ended_at >= ${from} AND ended_at < ${to} AND status = 'completed' THEN 1 ELSE 0 END)::int as completed
          FROM scan_sessions
          WHERE tenant_id = ${tenantId}
            AND store_id = ${storeId}
            AND deleted_at IS NULL
        `),
      dbConn.execute<{
        added: number;
        expired: number;
        near_expiry: number;
      }>(sql`
          SELECT
            sum(CASE WHEN created_at >= ${from} AND created_at < ${to} THEN 1 ELSE 0 END)::int as added,
            sum(CASE WHEN status = 'expired' THEN 1 ELSE 0 END)::int as expired,
            sum(CASE WHEN status = 'yellow' THEN 1 ELSE 0 END)::int as near_expiry
          FROM expiry_records
          WHERE tenant_id = ${tenantId}
            AND store_id = ${storeId}
            AND deleted_at IS NULL
        `),
      dbConn.execute<{ generated: number; resolved: number }>(sql`
          SELECT
            sum(CASE WHEN created_at >= ${from} AND created_at < ${to} THEN 1 ELSE 0 END)::int as generated,
            sum(CASE WHEN resolved_at IS NOT NULL AND resolved_at >= ${from} AND resolved_at < ${to} THEN 1 ELSE 0 END)::int as resolved
          FROM expiry_alerts
          WHERE tenant_id = ${tenantId}
            AND store_id = ${storeId}
        `),
      this.collectTaskStatsIfPresent(tenantId, storeId, from, to),
      dbConn.execute<{ active: number }>(sql`
          SELECT count(DISTINCT user_id)::int as active
          FROM scan_items
          WHERE tenant_id = ${tenantId}
            AND store_id = ${storeId}
            AND deleted_at IS NULL
            AND scanned_at >= ${from}
            AND scanned_at < ${to}
        `),
    ]);

    const sRow = (
      scans as unknown as {
        rows: Array<{
          total: number;
          unique_products: number;
          matched: number;
          unmatched: number;
        }>;
      }
    ).rows?.[0];
    const sesRow = (sessions as unknown as { rows: Array<{ started: number; completed: number }> })
      .rows?.[0];
    const eRow = (
      expiry as unknown as {
        rows: Array<{ added: number; expired: number; near_expiry: number }>;
      }
    ).rows?.[0];
    const aRow = (
      expiryAlerts as unknown as {
        rows: Array<{ generated: number; resolved: number }>;
      }
    ).rows?.[0];
    const auRow = (activeUsers as unknown as { rows: Array<{ active: number }> }).rows?.[0];

    return {
      totalScans: Number(sRow?.total ?? 0),
      uniqueProducts: Number(sRow?.unique_products ?? 0),
      matchedScans: Number(sRow?.matched ?? 0),
      unmatchedScans: Number(sRow?.unmatched ?? 0),
      sessionsStarted: Number(sesRow?.started ?? 0),
      sessionsCompleted: Number(sesRow?.completed ?? 0),
      expiryRecordsAdded: Number(eRow?.added ?? 0),
      expiredItems: Number(eRow?.expired ?? 0),
      nearExpiryItems: Number(eRow?.near_expiry ?? 0),
      alertsGenerated: Number(aRow?.generated ?? 0),
      alertsResolved: Number(aRow?.resolved ?? 0),
      tasksCreated: taskStats.created,
      tasksCompleted: taskStats.completed,
      tasksOverdue: taskStats.overdue,
      averageTaskMinutes:
        taskStats.averageMinutes === null ? null : taskStats.averageMinutes.toFixed(2),
      activeUsers: Number(auRow?.active ?? 0),
      metadata: {},
    };
  }

  private async collectTaskStatsIfPresent(
    tenantId: string,
    storeId: string,
    from: Date,
    to: Date,
  ): Promise<{
    created: number;
    completed: number;
    overdue: number;
    averageMinutes: number | null;
  }> {
    const dbConn = this.db.getDb();
    const tableExists = (await dbConn.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'tasks'
      ) as exists
    `)) as unknown as { rows: Array<{ exists: boolean }> };
    if (!tableExists.rows?.[0]?.exists) {
      return { created: 0, completed: 0, overdue: 0, averageMinutes: null };
    }
    const stats = (await dbConn.execute<{
      created: number;
      completed: number;
      overdue: number;
      avg_minutes: number | null;
    }>(sql`
      SELECT
        sum(CASE WHEN created_at >= ${from} AND created_at < ${to} THEN 1 ELSE 0 END)::int as created,
        sum(CASE WHEN status = 'completed' AND completed_at >= ${from} AND completed_at < ${to} THEN 1 ELSE 0 END)::int as completed,
        sum(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END)::int as overdue,
        AVG(CASE WHEN completed_at IS NOT NULL AND completed_at >= ${from} AND completed_at < ${to}
                 THEN EXTRACT(EPOCH FROM (completed_at - created_at)) / 60 END) as avg_minutes
      FROM tasks
      WHERE tenant_id = ${tenantId}
        AND store_id = ${storeId}
    `)) as unknown as {
      rows: Array<{
        created: number;
        completed: number;
        overdue: number;
        avg_minutes: number | null;
      }>;
    };
    const row = stats.rows?.[0];
    return {
      created: Number(row?.created ?? 0),
      completed: Number(row?.completed ?? 0),
      overdue: Number(row?.overdue ?? 0),
      averageMinutes:
        row?.avg_minutes === null || row?.avg_minutes === undefined
          ? null
          : Number(row.avg_minutes),
    };
  }
}

const startOfUtcDay = (d: Date): Date => {
  const out = new Date(d.getTime());
  out.setUTCHours(0, 0, 0, 0);
  return out;
};

const addDays = (d: Date, days: number): Date => {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
};
