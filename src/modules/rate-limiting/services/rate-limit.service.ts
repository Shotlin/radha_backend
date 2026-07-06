import { Inject, Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import type { QuotaKind, RateLimitResult } from '../dto/rate-limit-result.dto';
import {
  REDIS_QUOTA_PORT,
  RedisQuotaPort,
  USER_TIER_PORT,
  UserTierPort,
} from '../ports/redis-quota.port';
import {
  midnightISTAsIso,
  monthEndISTAsIso,
  secondsUntilMidnightIST,
  secondsUntilMonthEndIST,
  todayIST,
  yearMonthIST,
} from '../utils/ist-time.util';

import { QuotaConfigService } from './quota-config.service';

/**
 * BE-46 — Per-user daily / monthly quota enforcement.
 *
 * Redis is used as the source of truth so the counter survives
 * pod restarts within the same window and the INCR is atomic
 * across concurrent scans (Req 40 SOP item: "quota safe under
 * concurrency").
 *
 * Flow:
 *   1. Resolve the user's tier via `UserTierPort` (BE-08 v2).
 *   2. If the tier is unlimited for this kind, return `allowed`
 *      without touching Redis — paying tiers shouldn't pay a
 *      round-trip per request.
 *   3. Compose the per-window key (`quota:` for daily,
 *      `quota_month:` for monthly).
 *   4. INCR + EXPIRE atomically (EXPIRE is set every call so an
 *      observed key can't outlive its window even if a previous
 *      EXPIRE failed).
 *   5. Compare the post-increment value against the limit.
 *   6. On exceed: emit an audit event + a structured analytics
 *      log (`feature_locked_seen`) so the App Owner Dashboard
 *      surfaces upgrade nudges.
 *
 * Resilience: the Redis port can degrade (no-op fallback). When
 * `incr` returns 0 / NaN we treat it as "unknown" and fail open
 * for the current request — but log a warning so OPS knows the
 * counter is degraded. The matching SOP question
 * ("Redis unavailable — fail open or closed?") is decided here:
 *   ⇒ FAIL OPEN, audited.
 */
@Injectable()
export class RateLimitService {
  constructor(
    @Inject(REDIS_QUOTA_PORT)
    private readonly redis: RedisQuotaPort,
    @Inject(USER_TIER_PORT)
    private readonly tier: UserTierPort,
    private readonly quotaConfig: QuotaConfigService,
    private readonly logger: LoggerService,
    private readonly audit: AuditLogService,
  ) {}

  async checkAndIncrement(userId: string, kind: QuotaKind): Promise<RateLimitResult> {
    if (!userId) {
      // Defensive: the guard is supposed to enforce auth before us.
      return { allowed: false, quota: kind, limit: 0, used: 0 };
    }

    const { tier } = await this.tier.resolveTier(userId);
    const cfg = this.quotaConfig.getLimit(tier, kind);

    if (cfg.limit === Number.POSITIVE_INFINITY) {
      return { allowed: true };
    }

    const now = new Date();
    const { key, ttlSeconds, resetAt } = this.buildKey(userId, kind, cfg.window, now);

    let used: number;
    try {
      used = await this.redis.incr(key);
      if (Number.isFinite(used) && used > 0) {
        await this.redis.expire(key, ttlSeconds);
      }
    } catch (err) {
      // Fail open with a warning — quota is best-effort vs Redis.
      this.logger.warn('rate_limit.redis_degraded', {
        userId,
        kind,
        message: err instanceof Error ? err.message : 'unknown',
      });
      return { allowed: true };
    }

    if (!Number.isFinite(used) || used <= 0) {
      // Port returned a no-op value (degraded). Fail open.
      this.logger.warn('rate_limit.counter_unavailable', { userId, kind });
      return { allowed: true };
    }

    const allowed = used <= cfg.limit;
    if (allowed) {
      return {
        allowed: true,
        quota: kind,
        limit: cfg.limit,
        used,
        resetAt,
        window: cfg.window,
      };
    }

    // Anti-abuse: log audit entry on quota exceed + emit
    // analytics-style structured log for `feature_locked_seen`.
    await this.recordExceed(userId, kind, cfg.limit, used, resetAt, cfg.window);

    return {
      allowed: false,
      quota: kind,
      limit: cfg.limit,
      used,
      resetAt,
      window: cfg.window,
    };
  }

  /**
   * Read-only counter peek. Doesn't increment — used by status
   * endpoints / future quota-status APIs.
   */
  async getUsage(userId: string, kind: QuotaKind): Promise<RateLimitResult> {
    const { tier } = await this.tier.resolveTier(userId);
    const cfg = this.quotaConfig.getLimit(tier, kind);
    if (cfg.limit === Number.POSITIVE_INFINITY) {
      return { allowed: true };
    }
    const now = new Date();
    const { key, resetAt } = this.buildKey(userId, kind, cfg.window, now);
    const raw = await this.redis.get(key).catch(() => null);
    const used = raw ? Number(raw) : 0;
    return {
      allowed: used < cfg.limit,
      quota: kind,
      limit: cfg.limit,
      used,
      resetAt,
      window: cfg.window,
    };
  }

  private buildKey(
    userId: string,
    kind: QuotaKind,
    window: 'daily' | 'monthly',
    now: Date,
  ): { key: string; ttlSeconds: number; resetAt: string } {
    if (window === 'monthly') {
      return {
        key: `quota_month:${userId}:${kind}:${yearMonthIST(now)}`,
        ttlSeconds: secondsUntilMonthEndIST(now),
        resetAt: monthEndISTAsIso(now),
      };
    }
    return {
      key: `quota:${userId}:${kind}:${todayIST(now)}`,
      ttlSeconds: secondsUntilMidnightIST(now),
      resetAt: midnightISTAsIso(now),
    };
  }

  private async recordExceed(
    userId: string,
    kind: QuotaKind,
    limit: number,
    used: number,
    resetAt: string,
    window: 'daily' | 'monthly',
  ): Promise<void> {
    // PostHog `feature_locked_seen` event — wired through the
    // structured logger for now. BE-49 (analytics) will pick the
    // event up via a logger transport instead of duplicating SDK
    // wiring across modules.
    this.logger.info('analytics.feature_locked_seen', {
      analytics: true,
      event: 'feature_locked_seen',
      properties: {
        userId,
        quota: kind,
        limit,
        used,
        resetAt,
        window,
      },
    });

    try {
      await this.audit.logAction({
        action: 'READ',
        resourceType: 'Quota',
        resourceId: `${kind}:${userId}`,
        userId,
        tenantId: '',
        success: false,
        errorCode: 'QUOTA_EXCEEDED',
        metadata: { kind, limit, used, resetAt, window },
      });
    } catch (err) {
      // Audit write should never break the request flow.
      this.logger.warn('rate_limit.audit_failed', {
        userId,
        kind,
        message: err instanceof Error ? err.message : 'unknown',
      });
    }
  }
}
