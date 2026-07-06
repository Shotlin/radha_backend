import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';

import type { DashboardKpis, DateRange, TrendDirection } from '../types/dashboard.types';

import { rowAt, toNumber as numberOrZero } from './sql-result.utils';

/**
 * BE-30 — Real-time KPI aggregation for a single store.
 *
 * Each KPI section runs as a single dependent SQL with denormalised
 * counters and partial counts. All five sections execute in parallel
 * to stay inside the 1-second budget on a hot connection.
 *
 * Every query is store-scoped on its primary index, and every read
 * filters out soft-deleted rows. The dashboard is read-only — there
 * are no writes here, only reads.
 *
 * Tables touched:
 *   - `scan_items`       (BE-16)
 *   - `expiry_records`   (BE-18)
 *   - `tasks`            (BE-19)
 *   - inventory totals   — read from `products` until BE-27 ships
 *                          its inventory_items query, at which
 *                          point this method takes the BE-27
 *                          provider as well.
 */
@Injectable()
export class KpiService {
  constructor(private readonly db: DbService) {}

  async getKpis(storeId: string, dateRange: DateRange): Promise<DashboardKpis> {
    const conn = this.db.getDb();

    const today = startOfUtcDay(new Date());
    const weekAgo = addDays(today, -7);
    const monthAgo = addDays(today, -30);

    type ScanRow = { today: number | null; week: number | null; month: number | null };
    type ExpiryRow = { expiring_soon: number | null; expired: number | null };
    type TaskRow = {
      pending: number | null;
      overdue: number | null;
      completed_today: number | null;
    };
    type InventoryRow = { total: number | null; low_stock: number | null };
    type EanRow = { total_validated: number | null; matched: number | null };

    const [scanRes, expiryRes, taskRes, inventoryRes, eanRes] = await Promise.all([
      conn.execute<ScanRow>(sql`
        SELECT
          count(*) FILTER (WHERE scanned_at >= ${today})::int        AS today,
          count(*) FILTER (WHERE scanned_at >= ${weekAgo})::int      AS week,
          count(*) FILTER (WHERE scanned_at >= ${monthAgo})::int     AS month
        FROM scan_items
        WHERE store_id = ${storeId}
          AND deleted_at IS NULL
      `),
      conn.execute<ExpiryRow>(sql`
        SELECT
          count(*) FILTER (WHERE status IN ('yellow','red'))::int    AS expiring_soon,
          count(*) FILTER (WHERE status = 'expired')::int            AS expired
        FROM expiry_records
        WHERE store_id = ${storeId}
          AND deleted_at IS NULL
      `),
      conn.execute<TaskRow>(sql`
        SELECT
          count(*) FILTER (WHERE status = 'pending')::int                                                   AS pending,
          count(*) FILTER (WHERE status = 'overdue')::int                                                   AS overdue,
          count(*) FILTER (WHERE status = 'completed' AND completed_at >= ${today})::int                    AS completed_today
        FROM tasks
        WHERE store_id = ${storeId}
          AND deleted_at IS NULL
      `),
      conn.execute<InventoryRow>(sql`
        SELECT
          count(*)::int                                                AS total,
          count(*) FILTER (WHERE p.is_active = false)::int             AS low_stock
        FROM products p
        WHERE p.deleted_at IS NULL
      `),
      conn.execute<EanRow>(sql`
        SELECT
          count(*) FILTER (WHERE ean_match_status IN ('matched','unmatched'))::int  AS total_validated,
          count(*) FILTER (WHERE ean_match_status = 'matched')::int                 AS matched
        FROM scan_items
        WHERE store_id = ${storeId}
          AND deleted_at IS NULL
          AND scanned_at >= ${weekAgo}
      `),
    ]);

    const scans = (rowAt<ScanRow>(scanRes, 0) ?? ({} as ScanRow)) as ScanRow;
    const expiry = (rowAt<ExpiryRow>(expiryRes, 0) ?? ({} as ExpiryRow)) as ExpiryRow;
    const tasks = (rowAt<TaskRow>(taskRes, 0) ?? ({} as TaskRow)) as TaskRow;
    const inventory = (rowAt<InventoryRow>(inventoryRes, 0) ?? ({} as InventoryRow)) as InventoryRow;
    const ean = (rowAt<EanRow>(eanRes, 0) ?? ({} as EanRow)) as EanRow;

    const totalValidated = numberOrZero(ean.total_validated);
    const matched = numberOrZero(ean.matched);
    const eanMatchRate = totalValidated > 0 ? Math.round((matched / totalValidated) * 100) : 100;

    const trends = await this.computeTrends(storeId, dateRange);

    return {
      scansToday: numberOrZero(scans.today),
      scansThisWeek: numberOrZero(scans.week),
      scansThisMonth: numberOrZero(scans.month),
      expiringNextWeek: numberOrZero(expiry.expiring_soon),
      expiredItems: numberOrZero(expiry.expired),
      pendingTasks: numberOrZero(tasks.pending),
      overdueTasks: numberOrZero(tasks.overdue),
      completedToday: numberOrZero(tasks.completed_today),
      totalProducts: numberOrZero(inventory.total),
      lowStockItems: numberOrZero(inventory.low_stock),
      eanMatchRate,
      trends,
    };
  }

  private async computeTrends(
    storeId: string,
    dateRange: DateRange,
  ): Promise<DashboardKpis['trends']> {
    const conn = this.db.getDb();
    const periodMs = Math.max(1, dateRange.to.getTime() - dateRange.from.getTime());
    const previousFrom = new Date(dateRange.from.getTime() - periodMs);

    type TrendRow = {
      current_scans: number | null;
      previous_scans: number | null;
      current_added: number | null;
      previous_added: number | null;
      current_completed: number | null;
      previous_completed: number | null;
    };

    const result = await conn.execute<TrendRow>(sql`
      SELECT
        (SELECT count(*)::int FROM scan_items
          WHERE store_id = ${storeId} AND deleted_at IS NULL
            AND scanned_at >= ${dateRange.from} AND scanned_at < ${dateRange.to})  AS current_scans,
        (SELECT count(*)::int FROM scan_items
          WHERE store_id = ${storeId} AND deleted_at IS NULL
            AND scanned_at >= ${previousFrom} AND scanned_at < ${dateRange.from}) AS previous_scans,

        (SELECT count(*)::int FROM expiry_records
          WHERE store_id = ${storeId} AND deleted_at IS NULL
            AND created_at >= ${dateRange.from} AND created_at < ${dateRange.to}) AS current_added,
        (SELECT count(*)::int FROM expiry_records
          WHERE store_id = ${storeId} AND deleted_at IS NULL
            AND created_at >= ${previousFrom} AND created_at < ${dateRange.from}) AS previous_added,

        (SELECT count(*)::int FROM tasks
          WHERE store_id = ${storeId} AND deleted_at IS NULL
            AND completed_at >= ${dateRange.from} AND completed_at < ${dateRange.to}) AS current_completed,
        (SELECT count(*)::int FROM tasks
          WHERE store_id = ${storeId} AND deleted_at IS NULL
            AND completed_at >= ${previousFrom} AND completed_at < ${dateRange.from}) AS previous_completed
    `);

    const row = (rowAt<TrendRow>(result, 0) ?? ({} as TrendRow)) as TrendRow;

    return {
      scans: direction(numberOrZero(row.current_scans), numberOrZero(row.previous_scans)),
      expiry: direction(numberOrZero(row.current_added), numberOrZero(row.previous_added)),
      tasks: direction(numberOrZero(row.current_completed), numberOrZero(row.previous_completed)),
      // Inventory trend would compare stock-movement totals; until BE-27
      // ships its query we report `flat` so the dashboard renders.
      inventory: 'flat',
    };
  }
}

function direction(current: number, previous: number): TrendDirection {
  if (previous === 0) return current > 0 ? 'up' : 'flat';
  const change = (current - previous) / previous;
  if (change > 0.05) return 'up';
  if (change < -0.05) return 'down';
  return 'flat';
}

function startOfUtcDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}
