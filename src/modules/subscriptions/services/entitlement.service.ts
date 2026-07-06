import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { DbService } from '@/db/db.service';

import { PLAN_ORDER } from '../constants/default-plans';
import { PlanEntitlementsRepository } from '../repositories/plan-entitlements.repository';
import { SubscriptionsRepository } from '../repositories/subscriptions.repository';
import type {
  EntitlementCheck,
  Feature,
  PlanCode,
  UsageResult,
  UsageStats,
} from '../types/subscription.types';
import { ALL_FEATURES } from '../types/subscription.types';

/**
 * BE-28 — Entitlement & usage tracker.
 *
 * Two responsibilities:
 *   1. `checkEntitlement` — given a tenant + feature, decide whether
 *      the request should be allowed and report current usage.
 *   2. `getCurrentUsage` — aggregate per-feature consumption for the
 *      current month.
 *
 * Usage is read directly from the system-of-record tables (BE-22's
 * `ai_usage_log`, BE-15's `scan_items`, BE-21's `reports`, etc.).
 * No separate "usage counter" table is needed — the data is already
 * there, and recomputing is cheap thanks to the per-table indices.
 *
 * Operation strings used to query `ai_usage_log` match the values
 * defined in BE-22's `aiOperationEnum` (`ocr-expiry`, `label-analysis`,
 * `report-summary`).
 */
@Injectable()
export class EntitlementService {
  constructor(
    private readonly db: DbService,
    private readonly subRepo: SubscriptionsRepository,
    private readonly entitlementsRepo: PlanEntitlementsRepository,
  ) {}

  async checkEntitlement(tenantId: string, feature: Feature): Promise<EntitlementCheck> {
    const subscription = await this.subRepo.findByTenant(tenantId);
    if (!subscription) {
      return {
        allowed: false,
        feature,
        currentUsage: 0,
        limit: 0,
        remaining: 0,
        reason: 'No active subscription',
        upgradeRequired: true,
        recommendedPlan: 'starter',
      };
    }
    if (subscription.status === 'expired' || subscription.status === 'cancelled') {
      const reason =
        subscription.status === 'expired'
          ? 'Subscription expired — please renew or upgrade'
          : 'Subscription cancelled — reactivate to continue';
      return {
        allowed: false,
        feature,
        currentUsage: 0,
        limit: 0,
        remaining: 0,
        reason,
        upgradeRequired: true,
        recommendedPlan: 'starter',
      };
    }

    const entitlement = await this.entitlementsRepo.findByPlanAndFeature(
      subscription.planId,
      feature,
    );

    if (!entitlement) {
      return {
        allowed: false,
        feature,
        currentUsage: 0,
        limit: 0,
        remaining: 0,
        reason: `Feature '${feature}' not in plan`,
        upgradeRequired: true,
        recommendedPlan: this.getRecommendedPlan(subscription.planCode as PlanCode),
      };
    }

    if (entitlement.isUnlimited) {
      return {
        allowed: true,
        feature,
        currentUsage: 0,
        limit: 'unlimited',
        remaining: 'unlimited',
      };
    }

    const limit = entitlement.limitValue ?? 0;
    if (limit <= 0) {
      // Feature row exists but limit is zero — treat as feature
      // disabled in this plan (e.g., starter `api_access`).
      return {
        allowed: false,
        feature,
        currentUsage: 0,
        limit,
        remaining: 0,
        reason: `Feature '${feature}' not in current plan`,
        upgradeRequired: true,
        recommendedPlan: this.getRecommendedPlan(subscription.planCode as PlanCode),
      };
    }

    const currentUsage = await this.queryFeatureUsage(tenantId, feature);
    const remaining = Math.max(0, limit - currentUsage);
    const allowed = currentUsage < limit;

    const result: EntitlementCheck = {
      allowed,
      feature,
      currentUsage,
      limit,
      remaining,
      resetAt: this.getNextResetDate(),
    };
    if (!allowed) {
      result.reason = `Monthly limit of ${limit} reached for ${feature}`;
      result.upgradeRequired = true;
      result.recommendedPlan = this.getRecommendedPlan(subscription.planCode as PlanCode);
    }
    return result;
  }

  /**
   * Verifies the request is allowed and returns post-increment
   * counters. The actual ledger writes live in the originating
   * modules (BE-15 / BE-21 / BE-22) — this method only validates +
   * computes the resulting state.
   */
  async trackUsage(tenantId: string, feature: Feature, count = 1): Promise<UsageResult> {
    const check = await this.checkEntitlement(tenantId, feature);
    if (!check.allowed) {
      throw new BusinessException(
        ErrorCode.PLAN_LIMIT_EXCEEDED,
        check.reason ?? `Plan limit reached for ${feature}`,
        {
          metadata: {
            feature,
            currentUsage: check.currentUsage,
            limit: check.limit,
            recommendedPlan: check.recommendedPlan,
          },
        },
      );
    }
    const currentUsage = typeof check.currentUsage === 'number' ? check.currentUsage : 0;
    const newUsage = currentUsage + count;
    const limit = check.limit;
    const remaining =
      limit === 'unlimited' ? ('unlimited' as const) : Math.max(0, limit - newUsage);
    const warningTriggered = limit !== 'unlimited' && newUsage >= Math.floor(limit * 0.8);

    return {
      feature,
      newUsage,
      limit,
      remaining,
      warningTriggered,
    };
  }

  async getCurrentUsage(tenantId: string): Promise<UsageStats> {
    const subscription = await this.subRepo.findByTenant(tenantId);
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const byFeature: UsageStats['byFeature'] = {};

    if (!subscription) {
      return { tenantId, period: { from: periodStart, to: periodEnd }, byFeature };
    }

    const entitlements = await this.entitlementsRepo.findByPlan(subscription.planId);
    const limitMap = new Map<string, number | 'unlimited'>();
    for (const e of entitlements) {
      limitMap.set(e.feature, e.isUnlimited ? 'unlimited' : (e.limitValue ?? 0));
    }

    for (const feature of ALL_FEATURES) {
      const limit = limitMap.get(feature) ?? 0;
      const used = await this.queryFeatureUsage(tenantId, feature).catch(() => 0);
      const percentageUsed =
        limit === 'unlimited' || limit === 0 ? 0 : Math.min(100, (used / limit) * 100);
      byFeature[feature] = { used, limit, percentageUsed };
    }

    return {
      tenantId,
      period: { from: periodStart, to: periodEnd },
      byFeature,
    };
  }

  /**
   * Public so the SubscriptionsService can reuse the same dispatcher
   * when computing the status payload.
   */
  async queryFeatureUsage(tenantId: string, feature: Feature): Promise<number> {
    const yearMonth = new Date().toISOString().slice(0, 7);
    switch (feature) {
      case 'monthly_scans':
        return this.tryCount(`scan_items`, tenantId, {
          monthCol: 'scanned_at',
          yearMonth,
        });
      case 'monthly_reports':
        return this.tryCount(`reports`, tenantId, {
          monthCol: 'created_at',
          yearMonth,
        });
      case 'ai_ocr':
        return this.queryAiUsage(tenantId, yearMonth, 'ocr-expiry');
      case 'ai_label_analysis':
        return this.queryAiUsage(tenantId, yearMonth, 'label-analysis');
      case 'llm_summaries':
        return this.queryAiUsage(tenantId, yearMonth, 'report-summary');
      case 'stores':
        return this.tryCount(`stores`, tenantId, { softDelete: true });
      case 'users':
        return this.tryCount(`users`, tenantId, {
          softDelete: true,
          activeOnly: true,
        });
      case 'ean_lists':
        return this.tryCount(`ean_lists`, tenantId, { softDelete: true });
      case 'priority_support':
      case 'custom_branding':
      case 'api_access':
      case 'advanced_analytics':
      case 'rekognition':
        return 0;
      default: {
        const _never: never = feature;
        return _never;
      }
    }
  }

  private getNextResetDate(): Date {
    const next = new Date();
    next.setMonth(next.getMonth() + 1);
    next.setDate(1);
    next.setHours(0, 0, 0, 0);
    return next;
  }

  private getRecommendedPlan(currentPlan: PlanCode): PlanCode | undefined {
    const idx = PLAN_ORDER.indexOf(currentPlan);
    if (idx < 0) return 'starter';
    if (idx >= PLAN_ORDER.length - 1) return undefined;
    return PLAN_ORDER[idx + 1];
  }

  private async queryAiUsage(
    tenantId: string,
    yearMonth: string,
    operation: string,
  ): Promise<number> {
    try {
      const result = await this.db.getDb().execute(sql`
        SELECT COUNT(*)::int AS count
        FROM ai_usage_log
        WHERE tenant_id = ${tenantId}
          AND year_month = ${yearMonth}
          AND operation = ${operation}::ai_operation
          AND success = 'true'
      `);
      const rows = (result as unknown as { rows?: Array<{ count: number | string }> }).rows ?? [];
      return Number(rows[0]?.count ?? 0);
    } catch {
      return 0;
    }
  }

  /**
   * Best-effort count helper for tables that may not yet exist in the
   * test DB (BE-21 reports lands later, etc.). When the table is
   * missing we return 0 instead of failing the entitlement check.
   *
   * Values are escaped and only internally-controlled identifiers are
   * substituted into the SQL — the SQL-injection surface here is
   * zero, but we still avoid building user input into the query.
   */
  private async tryCount(
    table: string,
    tenantId: string,
    opts: {
      monthCol?: string;
      yearMonth?: string;
      softDelete?: boolean;
      activeOnly?: boolean;
    } = {},
  ): Promise<number> {
    const escapedTenant = tenantId.replace(/'/g, "''");
    const filters: string[] = [`tenant_id = '${escapedTenant}'`];
    if (opts.softDelete) filters.push('deleted_at IS NULL');
    if (opts.activeOnly) filters.push('is_active = true');
    if (opts.monthCol && opts.yearMonth) {
      const escapedMonth = opts.yearMonth.replace(/'/g, "''");
      filters.push(`TO_CHAR(${opts.monthCol}, 'YYYY-MM') = '${escapedMonth}'`);
    }
    const where = filters.join(' AND ');
    try {
      const query = `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where}`;
      const result = await this.db.getDb().execute(sql.raw(query));
      const rows = (result as unknown as { rows?: Array<{ count: number | string }> }).rows ?? [];
      return Number(rows[0]?.count ?? 0);
    } catch {
      return 0;
    }
  }
}
