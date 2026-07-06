import type { SubscriptionTier } from '@/shared-types';

/**
 * BE-46 — Discriminator for which counter is being checked.
 *
 *   - `scan` → daily quota for `consumer:scan` (Free Consumer = 50/day)
 *   - `save` → daily quota for `consumer:save_product`
 *              (Free Consumer = 5 saved products total)
 */
export type QuotaKind = 'scan' | 'save';

/**
 * BE-46 — Tier-resolved quota window.
 *
 * Daily window for free consumers (resets at 00:00 IST).
 * Monthly window for trial_pro / starter (resets at 00:00 IST on the
 * first of each month).
 */
export type QuotaWindow = 'daily' | 'monthly';

/**
 * BE-46 — Per-tier limit lookup.
 *
 * `limit === Number.POSITIVE_INFINITY` means "no quota enforcement at
 * this layer" — paying tiers are still subject to the global Req 24
 * rate limit (100 RPM) handled elsewhere.
 */
export interface QuotaLimit {
  tier: SubscriptionTier;
  kind: QuotaKind;
  limit: number;
  window: QuotaWindow;
}

/**
 * BE-46 — Result of `RateLimitService.checkAndIncrement`.
 *
 * Shape mirrors the 429 response body so the guard can serialise
 * the failure case without re-projecting fields.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** Echoed back so callers can branch on which counter blocked. */
  quota?: QuotaKind;
  /** Per-tier limit. Omitted when allowed and unlimited. */
  limit?: number;
  /** Post-increment counter (i.e. count after the current request). */
  used?: number;
  /** ISO-8601 wall-clock timestamp when the counter resets. */
  resetAt?: string;
  /** Window the counter is bound to (`daily` or `monthly`). */
  window?: QuotaWindow;
}

/** 429 response body served by `QuotaGuard` on quota exceed. */
export interface QuotaExceededResponse {
  allowed: false;
  quota: QuotaKind;
  limit: number;
  used: number;
  resetAt: string;
  window: QuotaWindow;
  /** Stable error code for the mobile client to switch on. */
  code: 'QUOTA_EXCEEDED';
  message: string;
}
