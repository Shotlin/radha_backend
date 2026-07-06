import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import { AI_DEFAULT_LIMITS, AI_OPERATION_UNIT_COST } from '../ai.constants';
import { AiUsageRepository } from '../repositories/ai-usage.repository';
import type {
  AiOperation,
  AiProvider,
  AiUsageRecord,
  DateRange,
  IUsageTrackerService,
  LimitCheckResult,
  UsageStats,
} from '../types/ai.types';

/**
 * BE-22 — Per-tenant cost & quota tracker.
 *
 * Doubles as the v2 ADDENDUM `cost-tracker.service.ts` (driver test
 * T-v2.1 — "cost tracker increments per-tenant counters on each
 * provider call"). Two writers:
 *
 *   - Orchestrator on every successful or failed AI call.
 *   - Explanation cache on a cache *miss* (cache hits don't burn
 *     budget so they aren't tracked here — the cache row's `hitCount`
 *     already records reuse).
 *
 * Limits are read from `AI_DEFAULT_LIMITS`. BE-31 (App Owner Dashboard)
 * will eventually read from a per-tenant override table, but the v1
 * fallback is the platform defaults.
 */
@Injectable()
export class UsageTrackerService implements IUsageTrackerService {
  constructor(
    private readonly repo: AiUsageRepository,
    private readonly logger: LoggerService,
  ) {}

  async trackUsage(record: AiUsageRecord): Promise<void> {
    const now = new Date();
    const yearMonth = now.toISOString().slice(0, 7);
    const yearMonthDay = now.toISOString().slice(0, 10);
    try {
      await this.repo.create({
        tenantId: record.tenantId,
        userId: record.userId ?? null,
        operation: record.operation,
        provider: record.provider,
        cost: String(record.cost ?? 0),
        durationMs: record.durationMs,
        tokensUsed: record.tokensUsed ?? 0,
        success: record.success ? 'true' : 'false',
        yearMonth,
        yearMonthDay,
        resourceId: record.resourceId ?? null,
        metadata: record.metadata ?? {},
      });
    } catch (err) {
      // Tracking failure must never break the user's request — fall
      // back to the structured logger as a poor-man's audit trail.
      this.logger.error('ai.usage.persist_failed', {
        error: { name: (err as Error).name, message: (err as Error).message },
        tenantId: record.tenantId,
        operation: record.operation,
        provider: record.provider,
      });
    }
  }

  async checkLimit(tenantId: string, operation: AiOperation): Promise<LimitCheckResult> {
    const limits = AI_DEFAULT_LIMITS[operation] ?? { monthly: 1000 };

    const now = new Date();
    const yearMonth = now.toISOString().slice(0, 7);
    const yearMonthDay = now.toISOString().slice(0, 10);

    const [monthlyUsed, dailyUsed] = await Promise.all([
      this.repo.countForMonth(tenantId, operation, yearMonth),
      limits.daily ? this.repo.countForDay(tenantId, operation, yearMonthDay) : Promise.resolve(0),
    ]);

    if (limits.daily && dailyUsed >= limits.daily) {
      const resetAt = new Date(now);
      resetAt.setUTCDate(resetAt.getUTCDate() + 1);
      resetAt.setUTCHours(0, 0, 0, 0);
      return {
        allowed: false,
        used: dailyUsed,
        limit: limits.daily,
        remaining: 0,
        resetAt,
        reason: `Daily limit of ${limits.daily} reached for ${operation}`,
      };
    }

    if (monthlyUsed >= limits.monthly) {
      const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      return {
        allowed: false,
        used: monthlyUsed,
        limit: limits.monthly,
        remaining: 0,
        resetAt,
        reason: `Monthly limit of ${limits.monthly} reached for ${operation}`,
      };
    }

    const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return {
      allowed: true,
      used: monthlyUsed,
      limit: limits.monthly,
      remaining: Math.max(0, limits.monthly - monthlyUsed),
      resetAt,
    };
  }

  async getUsageForTenant(tenantId: string, dateRange: DateRange): Promise<UsageStats> {
    const [opBreakdown, providerBreakdown] = await Promise.all([
      this.repo.getOperationBreakdown(tenantId, dateRange.from, dateRange.to),
      this.repo.getProviderBreakdown(tenantId, dateRange.from, dateRange.to),
    ]);

    const byOperation: UsageStats['byOperation'] = {};
    let totalCalls = 0;
    let totalCost = 0;
    let totalTokens = 0;

    for (const row of opBreakdown) {
      byOperation[row.operation] = {
        count: row.count,
        successCount: row.successCount,
        failureCount: row.failureCount,
        totalCost: row.totalCost,
        totalTokens: row.totalTokens,
        avgDurationMs: row.avgDurationMs,
      };
      totalCalls += row.count;
      totalCost += row.totalCost;
      totalTokens += row.totalTokens;
    }

    const byProvider: UsageStats['byProvider'] = {};
    for (const row of providerBreakdown) {
      byProvider[row.provider] = {
        count: row.count,
        totalCost: row.totalCost,
        totalTokens: row.totalTokens,
      };
    }

    return {
      tenantId,
      period: dateRange,
      byOperation,
      byProvider,
      totalCost,
      totalCalls,
      totalTokens,
    };
  }

  getCostBreakdown(tenantId: string, dateRange: DateRange): Promise<UsageStats> {
    return this.getUsageForTenant(tenantId, dateRange);
  }

  /**
   * Pure helper — no network / DB. Used by the orchestrator to surface
   * an "estimated spend" preview to the App Owner Dashboard without a
   * round-trip.
   */
  estimateCost(operation: AiOperation, count: number, provider?: AiProvider): number {
    void provider;
    return (AI_OPERATION_UNIT_COST[operation] ?? 0) * Math.max(0, count);
  }
}
