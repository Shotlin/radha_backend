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
 * BE-30 v2 — Team activity component (10 % of OHS).
 *
 * Score = `activeUsersToday / totalTeam`.
 *
 * "Active today" = users with at least one scan_item in the past
 * 24 hours scoped to this store. "Team" = active rows in
 * `user_store_access`.
 *
 * Zero-data fallback: a single-user / no-team store scores 1.0
 * (you can't fail a team metric you don't have a team for).
 */
@Injectable()
export class TeamActivityCalculator implements IComponentCalculator {
  readonly name: OhsComponentName = 'teamActivity';
  readonly weight = 0.1;

  constructor(private readonly db: DbService) {}

  async compute(input: ComponentInput): Promise<ComponentResult> {
    const conn = this.db.getDb();
    const since = addHours(input.asOf, -24);

    type CountRow = { cnt: number | string | null };

    const [teamRes, activeRes] = await Promise.all([
      conn.execute<CountRow>(sql`
        SELECT count(DISTINCT user_id)::int AS cnt
        FROM user_store_access
        WHERE store_id = ${input.storeId}
          AND is_active = true
      `),
      conn.execute<CountRow>(sql`
        SELECT count(DISTINCT user_id)::int AS cnt
        FROM scan_items
        WHERE store_id = ${input.storeId}
          AND deleted_at IS NULL
          AND scanned_at >= ${since}
          AND scanned_at <= ${input.asOf}
      `),
    ]);

    const total = toNumber(rowAt<CountRow>(teamRes, 0)?.cnt);
    const active = toNumber(rowAt<CountRow>(activeRes, 0)?.cnt);

    const rawScore = total > 0 ? clamp01(active / total) : 1;

    return {
      rawScore,
      rawInputs: {
        windowHours: 24,
        totalTeam: total,
        activeToday: active,
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

function addHours(d: Date, hours: number): Date {
  const out = new Date(d);
  out.setUTCHours(out.getUTCHours() + hours);
  return out;
}
