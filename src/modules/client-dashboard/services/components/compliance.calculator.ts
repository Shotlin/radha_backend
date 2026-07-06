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
 * BE-30 v2 — Compliance component (25 % of OHS).
 *
 * Score = `matched / validated` over the rolling 30-day window of
 * scan_items. Only scans whose `ean_match_status` is `matched` or
 * `unmatched` count as "validated" — `unchecked`, `invalid`, and
 * `no_list` are excluded so that the score reflects EAN-list
 * adherence, not scan volume.
 *
 * Zero-data fallback: when the store has zero validated scans in
 * the window we score `1.0` (perfect) — a brand new store hasn't
 * failed compliance yet, and a 0-score would unfairly drag the OHS
 * to ~75 from day 1.
 */
@Injectable()
export class ComplianceCalculator implements IComponentCalculator {
  readonly name: OhsComponentName = 'compliance';
  readonly weight = 0.25;

  constructor(private readonly db: DbService) {}

  async compute(input: ComponentInput): Promise<ComponentResult> {
    const conn = this.db.getDb();
    const from = addDays(input.asOf, -30);

    type Row = { validated: number | string | null; matched: number | string | null };
    const result = await conn.execute<Row>(sql`
      SELECT
        count(*) FILTER (WHERE ean_match_status IN ('matched','unmatched'))::int AS validated,
        count(*) FILTER (WHERE ean_match_status = 'matched')::int                AS matched
      FROM scan_items
      WHERE store_id = ${input.storeId}
        AND deleted_at IS NULL
        AND scanned_at >= ${from}
        AND scanned_at <= ${input.asOf}
    `);

    const row = (rowAt<Row>(result, 0) ?? ({} as Row)) as Row;
    const validated = toNumber(row.validated);
    const matched = toNumber(row.matched);

    const rawScore = validated > 0 ? clamp01(matched / validated) : 1;

    return {
      rawScore,
      rawInputs: {
        windowDays: 30,
        validated,
        matched,
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
