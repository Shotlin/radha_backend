import { Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { AiUsageRow, NewAiUsage, aiUsageLog } from '@/db/schema/ai';

import type { AiOperation, AiProvider } from '../types/ai.types';

interface OperationCount {
  operation: AiOperation;
  count: number;
  successCount: number;
  failureCount: number;
  totalCost: number;
  totalTokens: number;
  avgDurationMs: number;
}

interface ProviderCount {
  provider: AiProvider;
  count: number;
  totalCost: number;
  totalTokens: number;
}

/**
 * BE-22 — Tenant-scoped quota / cost ledger.
 *
 * The `(tenant_id, year_month, operation)` index makes the hot path
 * (`countForMonth`) a single index lookup. `getUsageForRange`
 * aggregates with `SUM`/`AVG` in SQL — never pulls rows back to
 * userland.
 */
@Injectable()
export class AiUsageRepository extends BaseRepository<
  typeof aiUsageLog,
  AiUsageRow,
  NewAiUsage,
  Partial<NewAiUsage>
> {
  constructor(db: DbService) {
    super(db.getDb(), aiUsageLog, 'ai_usage_log');
  }

  async countForMonth(
    tenantId: string,
    operation: AiOperation,
    yearMonth: string,
  ): Promise<number> {
    const [row] = (await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiUsageLog)
      .where(
        and(
          eq(aiUsageLog.tenantId, tenantId),
          eq(aiUsageLog.operation, operation),
          eq(aiUsageLog.yearMonth, yearMonth),
          eq(aiUsageLog.success, 'true'),
        ),
      )) as Array<{ count: number }>;
    return Number(row?.count ?? 0);
  }

  async countForDay(
    tenantId: string,
    operation: AiOperation,
    yearMonthDay: string,
  ): Promise<number> {
    const [row] = (await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiUsageLog)
      .where(
        and(
          eq(aiUsageLog.tenantId, tenantId),
          eq(aiUsageLog.operation, operation),
          eq(aiUsageLog.yearMonthDay, yearMonthDay),
          eq(aiUsageLog.success, 'true'),
        ),
      )) as Array<{ count: number }>;
    return Number(row?.count ?? 0);
  }

  async getOperationBreakdown(tenantId: string, from: Date, to: Date): Promise<OperationCount[]> {
    const rows = (await this.db
      .select({
        operation: aiUsageLog.operation,
        count: sql<number>`count(*)::int`,
        successCount: sql<number>`count(*) FILTER (WHERE success = 'true')::int`,
        failureCount: sql<number>`count(*) FILTER (WHERE success <> 'true')::int`,
        totalCost: sql<string>`coalesce(sum(cost), 0)`,
        totalTokens: sql<number>`coalesce(sum(tokens_used), 0)::int`,
        avgDurationMs: sql<number>`coalesce(avg(duration_ms), 0)::int`,
      })
      .from(aiUsageLog)
      .where(
        and(
          eq(aiUsageLog.tenantId, tenantId),
          gte(aiUsageLog.createdAt, from),
          lte(aiUsageLog.createdAt, to),
        ),
      )
      .groupBy(aiUsageLog.operation)) as Array<{
      operation: AiOperation;
      count: number;
      successCount: number;
      failureCount: number;
      totalCost: string;
      totalTokens: number;
      avgDurationMs: number;
    }>;

    return rows.map((r) => ({
      operation: r.operation,
      count: Number(r.count),
      successCount: Number(r.successCount),
      failureCount: Number(r.failureCount),
      totalCost: parseFloat(r.totalCost ?? '0'),
      totalTokens: Number(r.totalTokens),
      avgDurationMs: Number(r.avgDurationMs),
    }));
  }

  async getProviderBreakdown(tenantId: string, from: Date, to: Date): Promise<ProviderCount[]> {
    const rows = (await this.db
      .select({
        provider: aiUsageLog.provider,
        count: sql<number>`count(*)::int`,
        totalCost: sql<string>`coalesce(sum(cost), 0)`,
        totalTokens: sql<number>`coalesce(sum(tokens_used), 0)::int`,
      })
      .from(aiUsageLog)
      .where(
        and(
          eq(aiUsageLog.tenantId, tenantId),
          gte(aiUsageLog.createdAt, from),
          lte(aiUsageLog.createdAt, to),
        ),
      )
      .groupBy(aiUsageLog.provider)) as Array<{
      provider: AiProvider;
      count: number;
      totalCost: string;
      totalTokens: number;
    }>;

    return rows.map((r) => ({
      provider: r.provider,
      count: Number(r.count),
      totalCost: parseFloat(r.totalCost ?? '0'),
      totalTokens: Number(r.totalTokens),
    }));
  }
}
