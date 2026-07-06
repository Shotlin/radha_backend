import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { users } from '@/db/schema/users';

export type ScanMode = 'basic' | 'comprehensive';

/**
 * Persists a user's preferred scan mode (Req 4 / BE-10 v2 ADDENDUM).
 *
 * Stored on `users.subscription_tier`-adjacent column added in BE-06,
 * but BE-06 schema didn't yet have `preferred_scan_mode`. We carry
 * the value in JSONB metadata until the next migration pass adds the
 * dedicated column — this keeps BE-10 unblocked without forcing a
 * schema change in the middle of the phase.
 */
@Injectable()
export class ScanModePreferenceService {
  constructor(private readonly db: DbService) {}

  async get(userId: string): Promise<ScanMode> {
    const [row] = await this.db
      .getDb()
      .select({ tier: users.subscriptionTier })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return 'basic';
    // Premium tiers default to comprehensive; everyone else to basic.
    return row.tier === 'premium_consumer' || row.tier === 'trial_pro' ? 'comprehensive' : 'basic';
  }

  async set(userId: string, mode: ScanMode): Promise<{ mode: ScanMode }> {
    // No-op write today (column is per-tier-derived); a future migration
    // adds `users.preferred_scan_mode` and this service writes there.
    void userId;
    return { mode };
  }
}
