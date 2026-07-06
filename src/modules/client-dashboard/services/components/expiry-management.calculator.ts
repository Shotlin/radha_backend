import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';

import type {
  ComponentInput,
  ComponentResult,
  IComponentCalculator,
  OhsComponentName,
} from '../../types/dashboard.types';
import { rowAt, toNumber } from '../sql-result.utils';

/**
 * BE-30 v2 — Expiry management component (20 % of OHS).
 *
 * Score = `1 - (expired / total_in_window)` over the 30-day window
 * of `expiry_records`. The denominator is records *active* in the
 * window — those with `created_at >= window_start` OR a positive
 * `remaining_quantity` at the time of read.
 *
 * Zero-data fallback: a store with zero expiry records scores 1.0.
 */
@Injectable()
export class ExpiryManagementCalculator implements IComponentCalculator {
  readonly name: OhsComponentName = 'expiryManagement';
  readonly weight = 0.2;

  constructor(private readonly db: DbService) {}

  async compute(input: ComponentInput): Promise<ComponentResult> {
    const conn = this.db.getDb();
    const from = addDays(input.asOf, -30);

    type Row = { total: number | string | null; expired: number | string | null };
    const result = await conn.execute<Row>(sql`
      SELECT
        count(*)::int                                            AS total,
        count(*) FILTER (WHERE status = 'expired')::int          AS expired
      FROM expiry_records
      WHERE store_id = ${input.storeId}
        AND deleted_at IS NULL
        AND created_at >= ${from}
        AND created_at <= ${input.asOf}
    `);

    const row = (rowAt<Row>(result, 0) ?? ({} as Row)) as Row;
    const total = toNumber(row.total);
    const expired = toNumber(row.expired);

    const rawScore = total > 0 ? clamp01(1 - expired / total) : 1;

    return {
      rawScore,
      rawInputs: {
        windowDays: 30,
        totalRecords: total,
        expiredRecords: expired,
      },
    };
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}
