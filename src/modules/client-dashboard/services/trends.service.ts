import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';

import type { DataPoint, DateRange, TrendData } from '../types/dashboard.types';

import { rowsOf } from './sql-result.utils';

/**
 * BE-30 — Trend (time series) builder.
 *
 * Produces four daily series for the dashboard sparkline panels:
 *   - `scans`              — count(scan_items) per day
 *   - `expiryAdded`        — new expiry_records per day
 *   - `tasksCompleted`     — tasks transitioning to completed per day
 *   - `inventoryMovements` — placeholder until BE-27 lands; one
 *                            point per day with value 0 so the
 *                            mobile chart renders without spec
 *                            mismatch
 *
 * Every series is a contiguous run of dates inside the window — no
 * gaps. We backfill missing dates with `value: 0` so the mobile
 * sparkline can map index to day directly.
 */
@Injectable()
export class TrendsService {
  constructor(private readonly db: DbService) {}

  async getTrends(storeId: string, dateRange: DateRange): Promise<TrendData> {
    const conn = this.db.getDb();
    const days = enumerateDays(dateRange);

    type DayRow = { day: string; cnt: number | string };

    const [scansRes, expiryRes, taskRes] = await Promise.all([
      conn.execute<DayRow>(sql`
        SELECT to_char(scanned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
               count(*)::int                                          AS cnt
        FROM scan_items
        WHERE store_id = ${storeId}
          AND deleted_at IS NULL
          AND scanned_at >= ${dateRange.from}
          AND scanned_at <  ${dateRange.to}
        GROUP BY day
      `),
      conn.execute<DayRow>(sql`
        SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
               count(*)::int                                          AS cnt
        FROM expiry_records
        WHERE store_id = ${storeId}
          AND deleted_at IS NULL
          AND created_at >= ${dateRange.from}
          AND created_at <  ${dateRange.to}
        GROUP BY day
      `),
      conn.execute<DayRow>(sql`
        SELECT to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
               count(*)::int                                            AS cnt
        FROM tasks
        WHERE store_id = ${storeId}
          AND deleted_at IS NULL
          AND completed_at >= ${dateRange.from}
          AND completed_at <  ${dateRange.to}
        GROUP BY day
      `),
    ]);

    return {
      scans: backfill(days, indexBy(rowsOf<DayRow>(scansRes))),
      expiryAdded: backfill(days, indexBy(rowsOf<DayRow>(expiryRes))),
      tasksCompleted: backfill(days, indexBy(rowsOf<DayRow>(taskRes))),
      inventoryMovements: days.map((d) => ({ date: new Date(`${d}T00:00:00.000Z`), value: 0 })),
    };
  }
}

function enumerateDays(range: DateRange): string[] {
  const out: string[] = [];
  const start = new Date(range.from);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(range.to);
  end.setUTCHours(0, 0, 0, 0);
  for (let d = new Date(start); d.getTime() < end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function indexBy(rows: { day: string; cnt: number | string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const n = typeof row.cnt === 'string' ? Number(row.cnt) : row.cnt;
    out[row.day] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

function backfill(days: string[], lookup: Record<string, number>): DataPoint[] {
  return days.map((d) => ({ date: new Date(`${d}T00:00:00.000Z`), value: lookup[d] ?? 0 }));
}
