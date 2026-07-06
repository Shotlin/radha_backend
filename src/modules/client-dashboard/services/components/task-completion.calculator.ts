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
 * BE-30 v2 — Task completion component (15 % of OHS).
 *
 * Score = `completed / created` over the rolling 30-day window of
 * the `tasks` table. Both numerator and denominator are filtered
 * to tasks created inside the window, so a long-lived backlog
 * doesn't tank the score forever.
 *
 * Cancelled and rejected tasks are excluded from the denominator —
 * they were never expected to complete.
 *
 * Zero-data fallback: a store with no tasks scores 1.0.
 */
@Injectable()
export class TaskCompletionCalculator implements IComponentCalculator {
  readonly name: OhsComponentName = 'taskCompletion';
  readonly weight = 0.15;

  constructor(private readonly db: DbService) {}

  async compute(input: ComponentInput): Promise<ComponentResult> {
    const conn = this.db.getDb();
    const from = addDays(input.asOf, -30);

    type Row = { created: number | string | null; completed: number | string | null };
    const result = await conn.execute<Row>(sql`
      SELECT
        count(*) FILTER (WHERE status NOT IN ('cancelled','rejected'))::int  AS created,
        count(*) FILTER (WHERE status = 'completed')::int                    AS completed
      FROM tasks
      WHERE store_id = ${input.storeId}
        AND deleted_at IS NULL
        AND created_at >= ${from}
        AND created_at <= ${input.asOf}
    `);

    const row = (rowAt<Row>(result, 0) ?? ({} as Row)) as Row;
    const created = toNumber(row.created);
    const completed = toNumber(row.completed);

    const rawScore = created > 0 ? clamp01(completed / created) : 1;

    return {
      rawScore,
      rawInputs: {
        windowDays: 30,
        createdTasks: created,
        completedTasks: completed,
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
