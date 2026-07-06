import { Injectable } from '@nestjs/common';

import type { SubscriptionTier } from '@/shared-types';

import type { QuotaKind, QuotaLimit, QuotaWindow } from '../dto/rate-limit-result.dto';

/**
 * BE-46 — Per-tier quota table.
 *
 * Mirrors the matrix in `BE-46_PHASE.md`:
 *
 * | Tier              | Scans                | Saved Products |
 * |-------------------|----------------------|----------------|
 * | free_consumer     | 50/day               | 5 (cumulative) |
 * | premium_consumer  | ∞                    | ∞              |
 * | trial_pro         | 5,000/month          | ∞              |
 * | starter           | 5,000/month          | ∞              |
 * | growth            | ∞                    | ∞              |
 * | pro               | ∞                    | ∞              |
 *
 * `Number.POSITIVE_INFINITY` signals "no enforcement at this layer".
 * Paying tiers are still subject to Req 24's global 100 RPM limit
 * which is implemented elsewhere.
 *
 * The `save` counter for `free_consumer` is a cumulative limit —
 * we still use a daily key so the increment / expire flow is
 * uniform, but the quota is a hard cap on the user's saved-products
 * collection (enforced by the controller checking the actual saved
 * count first; the rate limiter is a defence-in-depth layer).
 */

/** Daily cap for free consumer scans. */
export const FREE_CONSUMER_SCAN_LIMIT = 50;
/** Cumulative cap for free consumer saved products. */
export const FREE_CONSUMER_SAVE_LIMIT = 5;
/** Monthly cap for trial_pro / starter scans (Starter plan limits). */
export const STARTER_MONTHLY_SCAN_LIMIT = 5000;

@Injectable()
export class QuotaConfigService {
  /**
   * Resolve the active limit for a `(tier, kind)` pair.
   *
   * Returns `Number.POSITIVE_INFINITY` for unlimited tiers; callers
   * (the rate-limit service) short-circuit on infinity instead of
   * touching Redis.
   */
  getLimit(tier: SubscriptionTier, kind: QuotaKind): QuotaLimit {
    const window = this.getWindow(tier, kind);
    const limit = this.getLimitValue(tier, kind);
    return { tier, kind, limit, window };
  }

  /**
   * Window the counter operates over. We separate this from the
   * limit value so the caller can pick the right Redis key prefix
   * and the right "seconds until reset" helper.
   */
  getWindow(tier: SubscriptionTier, _kind: QuotaKind): QuotaWindow {
    switch (tier) {
      case 'trial_pro':
      case 'starter':
        return 'monthly';
      case 'free_consumer':
      case 'premium_consumer':
      case 'growth':
      case 'pro':
      default:
        return 'daily';
    }
  }

  /** Returns whether the limit is enforced (i.e. not infinite). */
  isUnlimited(tier: SubscriptionTier, kind: QuotaKind): boolean {
    const limit = this.getLimitValue(tier, kind);
    return limit === Number.POSITIVE_INFINITY;
  }

  private getLimitValue(tier: SubscriptionTier, kind: QuotaKind): number {
    if (tier === 'free_consumer') {
      return kind === 'scan' ? FREE_CONSUMER_SCAN_LIMIT : FREE_CONSUMER_SAVE_LIMIT;
    }
    if (tier === 'trial_pro' || tier === 'starter') {
      // Pro/Starter monthly cap on scans; saved products are unlimited.
      return kind === 'scan' ? STARTER_MONTHLY_SCAN_LIMIT : Number.POSITIVE_INFINITY;
    }
    // premium_consumer / growth / pro — no quota at this layer.
    return Number.POSITIVE_INFINITY;
  }
}
