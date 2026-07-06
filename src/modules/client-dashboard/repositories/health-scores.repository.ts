import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  NewOperationalHealthScore,
  OperationalHealthScoreRow,
  operationalHealthScores,
} from '@/db/schema/operational-health-scores';

import type {
  HealthScorePersistedRow,
  HealthScoreTrendPoint,
  OhsComponentName,
} from '../types/dashboard.types';

/**
 * BE-30 v2 — Repository for `operational_health_scores`.
 *
 * Two narrow read paths plus one upsert:
 *   - `findLatest`        : the most recent persisted row for
 *                           `(tenant, store)` regardless of date.
 *   - `findTrend`         : up to N days of rows ordered by date,
 *                           grouped by algorithm version so the
 *                           dashboard can render version banners
 *                           when the algorithm changed mid-window.
 *   - `upsertForDate`     : idempotent write keyed on the
 *                           `(tenant, store, date, algorithm_version)`
 *                           unique index. Re-running the cron the
 *                           same day overwrites the row.
 *
 * Component scores are persisted as percent (0..100) and read back
 * as 0..1 normalised. The persisted shape is what the dashboard
 * sends to the wire; we keep the in-memory contract `[0, 1]` so
 * the calculators stay arithmetic.
 */
@Injectable()
export class HealthScoresRepository {
  constructor(private readonly db: DbService) {}

  async upsertForDate(input: {
    tenantId: string;
    storeId: string | null;
    computedForDate: string; // ISO date YYYY-MM-DD
    algorithmVersion: string;
    total: number;
    breakdown: Record<OhsComponentName, number>; // 0..1 normalised
    rawInputs: Record<OhsComponentName, Record<string, unknown>>;
  }): Promise<OperationalHealthScoreRow> {
    const conn = this.db.getDb();

    const values: NewOperationalHealthScore = {
      tenantId: input.tenantId,
      storeId: input.storeId ?? null,
      computedForDate: input.computedForDate,
      algorithmVersion: input.algorithmVersion,
      totalScore: round2(input.total).toFixed(2),
      complianceComponent: scoreToPercent(input.breakdown.compliance),
      expiryComponent: scoreToPercent(input.breakdown.expiryManagement),
      inventoryComponent: scoreToPercent(input.breakdown.inventoryAccuracy),
      taskComponent: scoreToPercent(input.breakdown.taskCompletion),
      teamActivityComponent: scoreToPercent(input.breakdown.teamActivity),
      vendorQualityComponent: scoreToPercent(input.breakdown.vendorQuality),
      rawInputs: input.rawInputs,
    } as NewOperationalHealthScore;

    const [row] = (await conn
      .insert(operationalHealthScores)
      .values(values)
      .onConflictDoUpdate({
        target: [
          operationalHealthScores.tenantId,
          operationalHealthScores.storeId,
          operationalHealthScores.computedForDate,
          operationalHealthScores.algorithmVersion,
        ],
        set: {
          totalScore: values.totalScore,
          complianceComponent: values.complianceComponent,
          expiryComponent: values.expiryComponent,
          inventoryComponent: values.inventoryComponent,
          taskComponent: values.taskComponent,
          teamActivityComponent: values.teamActivityComponent,
          vendorQualityComponent: values.vendorQualityComponent,
          rawInputs: values.rawInputs,
          computedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      })
      .returning()) as OperationalHealthScoreRow[];
    return row;
  }

  async findLatest(tenantId: string, storeId: string): Promise<HealthScorePersistedRow | null> {
    const conn = this.db.getDb();
    const rows = (await conn
      .select()
      .from(operationalHealthScores)
      .where(
        and(
          eq(operationalHealthScores.tenantId, tenantId),
          eq(operationalHealthScores.storeId, storeId),
        ),
      )
      .orderBy(desc(operationalHealthScores.computedForDate))
      .limit(1)) as OperationalHealthScoreRow[];
    return rows[0] ? this.toPersisted(rows[0]) : null;
  }

  async findPreviousDay(
    tenantId: string,
    storeId: string,
    beforeDate: string,
    algorithmVersion: string,
  ): Promise<HealthScorePersistedRow | null> {
    const conn = this.db.getDb();
    const rows = (await conn
      .select()
      .from(operationalHealthScores)
      .where(
        and(
          eq(operationalHealthScores.tenantId, tenantId),
          eq(operationalHealthScores.storeId, storeId),
          eq(operationalHealthScores.algorithmVersion, algorithmVersion),
          sql`${operationalHealthScores.computedForDate} < ${beforeDate}`,
        ),
      )
      .orderBy(desc(operationalHealthScores.computedForDate))
      .limit(1)) as OperationalHealthScoreRow[];
    return rows[0] ? this.toPersisted(rows[0]) : null;
  }

  async findTrend(
    tenantId: string,
    storeId: string,
    days: number,
  ): Promise<HealthScoreTrendPoint[]> {
    const conn = this.db.getDb();
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    const sinceIso = since.toISOString().slice(0, 10);

    const rows = (await conn
      .select({
        date: operationalHealthScores.computedForDate,
        total: operationalHealthScores.totalScore,
        algorithmVersion: operationalHealthScores.algorithmVersion,
      })
      .from(operationalHealthScores)
      .where(
        and(
          eq(operationalHealthScores.tenantId, tenantId),
          eq(operationalHealthScores.storeId, storeId),
          gte(operationalHealthScores.computedForDate, sinceIso),
        ),
      )
      .orderBy(operationalHealthScores.computedForDate)) as Array<{
      date: string;
      total: string;
      algorithmVersion: string;
    }>;

    return rows.map((r) => ({
      date: r.date,
      total: Number(r.total),
      algorithmVersion: r.algorithmVersion,
    }));
  }

  private toPersisted(row: OperationalHealthScoreRow): HealthScorePersistedRow {
    return {
      id: row.id,
      tenantId: row.tenantId,
      storeId: row.storeId,
      computedForDate:
        typeof row.computedForDate === 'string'
          ? row.computedForDate
          : new Date(row.computedForDate as unknown as string).toISOString().slice(0, 10),
      algorithmVersion: row.algorithmVersion,
      total: Number(row.totalScore),
      breakdown: {
        compliance: percentToScore(row.complianceComponent),
        expiryManagement: percentToScore(row.expiryComponent),
        inventoryAccuracy: percentToScore(row.inventoryComponent),
        taskCompletion: percentToScore(row.taskComponent),
        teamActivity: percentToScore(row.teamActivityComponent),
        vendorQuality: percentToScore(row.vendorQualityComponent),
      },
      computedAt: row.computedAt,
    };
  }
}

function scoreToPercent(value: number): string {
  // Drizzle expects decimal columns as string. Persist component
  // scores as their 0..100 percent equivalent (rawScore × 100).
  const pct = clamp01(value) * 100;
  return round2(pct).toFixed(2);
}

function percentToScore(persisted: string | number | null): number {
  if (persisted === null || persisted === undefined) return 0;
  const n = typeof persisted === 'string' ? Number(persisted) : persisted;
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
