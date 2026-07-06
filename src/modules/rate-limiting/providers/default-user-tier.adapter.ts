import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';

import type { SubscriptionTier } from '@/shared-types';

import type { TierResolution, UserTierPort } from '../ports/redis-quota.port';

/**
 * BE-46 — Default `UserTierPort` binding.
 *
 * Looks up the user's current `subscription_tier` directly from the
 * `users` table. We use a raw query rather than reaching into BE-08's
 * `UsersRepository` to keep this module dependency-light (no module
 * graph cycles between `rate-limiting` and `auth`).
 *
 * Failure mode: any DB error / unknown tier collapses to
 * `free_consumer`. This is the strictest-tier default and matches
 * the BE-46 anti-abuse stance ("hold to free quota when in doubt").
 */
const VALID_TIERS: ReadonlySet<SubscriptionTier> = new Set<SubscriptionTier>([
  'free_consumer',
  'premium_consumer',
  'trial_pro',
  'starter',
  'growth',
  'pro',
]);

@Injectable()
export class DefaultUserTierAdapter implements UserTierPort {
  constructor(
    @Optional() private readonly db: DbService | null,
    @Optional() private readonly logger?: LoggerService,
  ) {}

  async resolveTier(userId: string): Promise<TierResolution> {
    if (!this.db) return { tier: 'free_consumer' };
    try {
      const result = await this.db.getDb().execute(sql`
        SELECT subscription_tier::text AS tier
        FROM users
        WHERE id = ${userId}
        LIMIT 1
      `);
      const rows = (result as unknown as { rows?: Array<{ tier?: string | null }> }).rows ?? [];
      const tier = rows[0]?.tier ?? null;
      if (tier && VALID_TIERS.has(tier as SubscriptionTier)) {
        return { tier: tier as SubscriptionTier };
      }
      return { tier: 'free_consumer' };
    } catch (err) {
      this.logger?.warn('rate_limit.tier_lookup_failed', {
        userId,
        message: err instanceof Error ? err.message : 'unknown',
      });
      return { tier: 'free_consumer' };
    }
  }
}
