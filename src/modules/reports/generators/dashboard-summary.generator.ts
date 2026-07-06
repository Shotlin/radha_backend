import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';

import { DailyStoreMetricsRepository } from '../repositories/daily-store-metrics.repository';
import type {
  DashboardSummary,
  DateRange,
  GenerateReportParams,
  IReportGenerator,
  ReportData,
  ReportType,
} from '../types/report.types';

/**
 * BE-20 — Live dashboard summary.
 *
 * Six independent reads run in parallel so the request stays under
 * the 500 ms budget set by Test 3 in the BE-20 phase doc. The trend
 * series comes from `daily_store_metrics`; everything else hits the
 * raw tables for accuracy.
 */
@Injectable()
export class DashboardSummaryGenerator implements IReportGenerator<Record<string, unknown>> {
  readonly type: ReportType = 'dashboard';

  constructor(
    private readonly db: DbService,
    private readonly metricsRepo: DailyStoreMetricsRepository,
  ) {}

  async generate(
    params: GenerateReportParams,
    tenantId: string,
  ): Promise<ReportData<Record<string, unknown>>> {
    if (!params.storeIds || params.storeIds.length !== 1) {
      throw new Error(
        'Dashboard generator requires exactly one storeId. Pass `storeIds: [storeId]`.',
      );
    }
    const storeId = params.storeIds[0]!;
    const summary = await this.summarise(tenantId, storeId, params.dateRange);
    return {
      summary: summary as unknown as Record<string, unknown>,
      rows: [],
      meta: { storeId, dateRange: params.dateRange },
      generatedAt: summary.generatedAt,
    };
  }

  /** Convenience entry point for the live `/dashboard/summary` endpoint. */
  async summarise(
    tenantId: string,
    storeId: string,
    dateRange: DateRange,
  ): Promise<DashboardSummary> {
    const [scanStats, expiryStats, taskStats, trends, topProducts, topUsers] = await Promise.all([
      this.getScanStats(tenantId, storeId, dateRange),
      this.getExpiryStats(tenantId, storeId),
      this.getTaskStats(tenantId, storeId, dateRange),
      this.metricsRepo.getTrendPoints(tenantId, storeId, dateRange.from, dateRange.to),
      this.getTopProducts(tenantId, storeId, dateRange),
      this.getTopUsers(tenantId, storeId, dateRange),
    ]);

    return {
      storeId,
      dateRange,
      totals: {
        scans: scanStats.total,
        sessionsCompleted: scanStats.sessionsCompleted,
        expiryRecords: expiryStats.total,
        activeAlerts: expiryStats.activeAlerts,
        tasksCompleted: taskStats.completed,
        tasksOverdue: taskStats.overdue,
      },
      expiry: {
        green: expiryStats.green,
        yellow: expiryStats.yellow,
        red: expiryStats.red,
        expired: expiryStats.expired,
        unknown: expiryStats.unknown,
      },
      scanHealth: {
        matched: scanStats.matched,
        unmatched: scanStats.unmatched,
        matchRate:
          scanStats.total > 0 ? Math.round((scanStats.matched / scanStats.total) * 1000) / 10 : 0,
      },
      trends,
      topProducts,
      topUsers,
      generatedAt: new Date(),
    };
  }

  private async getScanStats(
    tenantId: string,
    storeId: string,
    dateRange: DateRange,
  ): Promise<{
    total: number;
    matched: number;
    unmatched: number;
    sessionsCompleted: number;
  }> {
    const dbConn = this.db.getDb();
    const [scans, sessions] = await Promise.all([
      dbConn.execute<{ total: number; matched: number; unmatched: number }>(sql`
        SELECT count(*)::int as total,
               sum(CASE WHEN ean_match_status = 'matched' THEN 1 ELSE 0 END)::int as matched,
               sum(CASE WHEN ean_match_status = 'unmatched' THEN 1 ELSE 0 END)::int as unmatched
        FROM scan_items
        WHERE tenant_id = ${tenantId}
          AND store_id = ${storeId}
          AND deleted_at IS NULL
          AND scanned_at >= ${dateRange.from}
          AND scanned_at <= ${dateRange.to}
      `),
      dbConn.execute<{ completed: number }>(sql`
        SELECT count(*)::int as completed
        FROM scan_sessions
        WHERE tenant_id = ${tenantId}
          AND store_id = ${storeId}
          AND status = 'completed'
          AND deleted_at IS NULL
          AND ended_at >= ${dateRange.from}
          AND ended_at <= ${dateRange.to}
      `),
    ]);
    const sRow = (
      scans as unknown as { rows: Array<{ total: number; matched: number; unmatched: number }> }
    ).rows?.[0];
    const sesRow = (sessions as unknown as { rows: Array<{ completed: number }> }).rows?.[0];
    return {
      total: Number(sRow?.total ?? 0),
      matched: Number(sRow?.matched ?? 0),
      unmatched: Number(sRow?.unmatched ?? 0),
      sessionsCompleted: Number(sesRow?.completed ?? 0),
    };
  }

  private async getExpiryStats(
    tenantId: string,
    storeId: string,
  ): Promise<{
    total: number;
    green: number;
    yellow: number;
    red: number;
    expired: number;
    unknown: number;
    activeAlerts: number;
  }> {
    const dbConn = this.db.getDb();
    const [statusRows, alertRows] = await Promise.all([
      dbConn.execute<{ status: string; count: number }>(sql`
        SELECT status, count(*)::int as count
        FROM expiry_records
        WHERE tenant_id = ${tenantId}
          AND store_id = ${storeId}
          AND deleted_at IS NULL
        GROUP BY status
      `),
      dbConn.execute<{ active: number }>(sql`
        SELECT count(*)::int as active
        FROM expiry_alerts
        WHERE tenant_id = ${tenantId}
          AND store_id = ${storeId}
          AND is_resolved = false
      `),
    ]);
    const stats = {
      total: 0,
      green: 0,
      yellow: 0,
      red: 0,
      expired: 0,
      unknown: 0,
      activeAlerts: 0,
    };
    for (const row of (
      statusRows as unknown as {
        rows: Array<{ status: string; count: number }>;
      }
    ).rows ?? []) {
      const count = Number(row.count);
      stats.total += count;
      if (row.status in stats) {
        (stats as Record<string, number>)[row.status] = count;
      }
    }
    stats.activeAlerts = Number(
      (alertRows as unknown as { rows: Array<{ active: number }> }).rows?.[0]?.active ?? 0,
    );
    return stats;
  }

  private async getTaskStats(
    tenantId: string,
    storeId: string,
    dateRange: DateRange,
  ): Promise<{ completed: number; overdue: number }> {
    const dbConn = this.db.getDb();
    const tableExists = (await dbConn.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'tasks'
      ) as exists
    `)) as unknown as { rows: Array<{ exists: boolean }> };
    if (!tableExists.rows?.[0]?.exists) {
      return { completed: 0, overdue: 0 };
    }

    const result = (await dbConn.execute<{ completed: number; overdue: number }>(sql`
      SELECT sum(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int as completed,
             sum(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END)::int as overdue
      FROM tasks
      WHERE tenant_id = ${tenantId}
        AND store_id = ${storeId}
        AND created_at >= ${dateRange.from}
        AND created_at <= ${dateRange.to}
    `)) as unknown as { rows: Array<{ completed: number; overdue: number }> };
    const row = result.rows?.[0];
    return {
      completed: Number(row?.completed ?? 0),
      overdue: Number(row?.overdue ?? 0),
    };
  }

  private async getTopProducts(
    tenantId: string,
    storeId: string,
    dateRange: DateRange,
  ): Promise<DashboardSummary['topProducts']> {
    const dbConn = this.db.getDb();
    const result = (await dbConn.execute<{
      product_id: string;
      product_name: string | null;
      scan_count: number;
    }>(sql`
      SELECT si.product_id,
             COALESCE(p.name, si.product_name_snapshot) as product_name,
             count(*)::int as scan_count
      FROM scan_items si
      LEFT JOIN products p ON p.id = si.product_id
      WHERE si.tenant_id = ${tenantId}
        AND si.store_id = ${storeId}
        AND si.deleted_at IS NULL
        AND si.product_id IS NOT NULL
        AND si.scanned_at >= ${dateRange.from}
        AND si.scanned_at <= ${dateRange.to}
      GROUP BY si.product_id, p.name, si.product_name_snapshot
      ORDER BY scan_count DESC
      LIMIT 10
    `)) as unknown as {
      rows: Array<{
        product_id: string;
        product_name: string | null;
        scan_count: number;
      }>;
    };
    return (result.rows ?? []).map((r) => ({
      productId: r.product_id,
      productName: r.product_name ?? 'Unknown product',
      scanCount: Number(r.scan_count),
    }));
  }

  private async getTopUsers(
    tenantId: string,
    storeId: string,
    dateRange: DateRange,
  ): Promise<DashboardSummary['topUsers']> {
    const dbConn = this.db.getDb();
    const result = (await dbConn.execute<{
      user_id: string;
      user_name: string | null;
      scan_count: number;
    }>(sql`
      SELECT si.user_id,
             u.name as user_name,
             count(*)::int as scan_count
      FROM scan_items si
      LEFT JOIN users u ON u.id = si.user_id
      WHERE si.tenant_id = ${tenantId}
        AND si.store_id = ${storeId}
        AND si.deleted_at IS NULL
        AND si.scanned_at >= ${dateRange.from}
        AND si.scanned_at <= ${dateRange.to}
      GROUP BY si.user_id, u.name
      ORDER BY scan_count DESC
      LIMIT 10
    `)) as unknown as {
      rows: Array<{
        user_id: string;
        user_name: string | null;
        scan_count: number;
      }>;
    };
    return (result.rows ?? []).map((r) => ({
      userId: r.user_id,
      userName: r.user_name ?? 'Unknown user',
      scanCount: Number(r.scan_count),
    }));
  }
}
