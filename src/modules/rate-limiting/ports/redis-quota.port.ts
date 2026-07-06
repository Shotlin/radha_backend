import type { SubscriptionTier } from '@/shared-types';

/**
 * BE-46 — Minimal Redis surface required by the quota service.
 *
 * Exists as a port so the module remains independent of the BE-32 v2
 * Redis wiring: the production binding lazy-loads `ioredis`, and the
 * unit tests inject an in-memory fake. The interface is deliberately
 * narrow — we only need atomic INCR + EXPIRE for counters.
 */
export interface RedisQuotaPort {
  /**
   * Atomically increment the integer at `key` (initial value `0`)
   * and return the post-increment value.
   */
  incr(key: string): Promise<number>;

  /**
   * Set the time-to-live of `key` in seconds. Should be a no-op
   * when the value is non-positive.
   */
  expire(key: string, seconds: number): Promise<void>;

  /**
   * Read the current counter value for telemetry / `getUsage`.
   * Returns `null` when the key has expired or never existed.
   */
  get(key: string): Promise<string | null>;

  /**
   * Cleanup hook so the module can `quit()` the connection at
   * `onModuleDestroy`. Optional — fakes can leave it unimplemented.
   */
  quit?(): Promise<void>;
}

/** Nest DI token for the Redis port. */
export const REDIS_QUOTA_PORT = Symbol('REDIS_QUOTA_PORT');

/**
 * BE-46 — Tier resolver port.
 *
 * `RateLimitService` doesn't talk to the auth / subscription
 * repositories directly — it consumes a tiny port the module rebinds
 * in tests. The default production binding wraps
 * `PermissionsService.getEntitlements` (BE-08 v2).
 */
export interface UserTierPort {
  /**
   * Resolve the user's current subscription tier. Implementations
   * should never throw — return a sensible default
   * (`free_consumer`) on lookup failure so the request is held to
   * the strictest quota rather than being let through.
   */
  resolveTier(userId: string): Promise<TierResolution>;
}

export interface TierResolution {
  tier: SubscriptionTier;
}

export const USER_TIER_PORT = Symbol('USER_TIER_PORT');
