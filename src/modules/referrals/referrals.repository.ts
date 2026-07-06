import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { NewReferralReward, referralRewards, ReferralRewardRow } from '@/db/schema/referrals';
import { users } from '@/db/schema/users';

/**
 * BE-43 — Drizzle data access for the Referral Program.
 *
 * Three responsibilities:
 *   1. Read users by referral code (case-sensitive — codes are always
 *      stored uppercase).
 *   2. Persist `referral_code` and `referred_by_user_id` updates on
 *      the `users` table.
 *   3. CRUD for `referral_rewards` with idempotency-aware insertion
 *      (silently no-ops if the (user_id, source, reward_type) tuple
 *      already exists).
 *
 * No business logic — the service layer decides whether a reward
 * should be granted in the first place.
 */
@Injectable()
export class ReferralsRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Find a user by their referral code. Codes are stored uppercase;
   * callers are expected to uppercase the input before calling.
   */
  async findUserByReferralCode(code: string): Promise<{
    id: string;
    referralCode: string | null;
    tenantId: string | null;
  } | null> {
    const [row] = await this.db
      .getDb()
      .select({
        id: users.id,
        referralCode: users.referralCode,
        tenantId: users.tenantId,
      })
      .from(users)
      .where(eq(users.referralCode, code))
      .limit(1);
    return row ?? null;
  }

  /**
   * Look up just the referral metadata for a user — used by
   * `GET /referrals/me` to decide whether to lazy-generate a code.
   */
  async findReferralMetaByUserId(userId: string): Promise<{
    id: string;
    referralCode: string | null;
    referredByUserId: string | null;
  } | null> {
    const [row] = await this.db
      .getDb()
      .select({
        id: users.id,
        referralCode: users.referralCode,
        referredByUserId: users.referredByUserId,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Set a user's referral code. Returns the row when the update lands
   * and `null` if the user no longer exists. Callers handle the
   * unique-index error (DB code 23505) at the service layer when two
   * concurrent generators collide.
   */
  async setReferralCode(userId: string, code: string): Promise<{ id: string } | null> {
    const [row] = await this.db
      .getDb()
      .update(users)
      .set({ referralCode: code, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    return row ?? null;
  }

  /**
   * Record the inviter on the invitee's row. Idempotent — if the
   * column is already populated the original value wins (we never
   * overwrite an existing referrer because that would re-attribute a
   * historical signup).
   */
  async setReferredBy(invitedUserId: string, inviterUserId: string): Promise<boolean> {
    const result = await this.db
      .getDb()
      .update(users)
      .set({ referredByUserId: inviterUserId, updatedAt: new Date() })
      .where(and(eq(users.id, invitedUserId), sql`${users.referredByUserId} IS NULL`))
      .returning({ id: users.id });
    return result.length > 0;
  }

  /**
   * Insert a referral reward row. Returns `null` when the
   * `(user_id, source_referral_user_id, reward_type)` triple already
   * exists — the database's unique index enforces idempotency for us
   * via `ON CONFLICT DO NOTHING`.
   */
  async createReward(data: NewReferralReward): Promise<ReferralRewardRow | null> {
    const rows = await this.db
      .getDb()
      .insert(referralRewards)
      .values(data)
      .onConflictDoNothing({
        target: [
          referralRewards.userId,
          referralRewards.sourceReferralUserId,
          referralRewards.rewardType,
        ],
      })
      .returning();
    return rows[0] ?? null;
  }

  /** Total rewards (any type) granted to a user. */
  async countRewardsForUser(userId: string): Promise<number> {
    const [row] = await this.db
      .getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(referralRewards)
      .where(eq(referralRewards.userId, userId));
    return row?.count ?? 0;
  }

  /**
   * Most recent rewards for a user, newest first.
   */
  async listRewardsForUser(userId: string, limit = 10): Promise<ReferralRewardRow[]> {
    return this.db
      .getDb()
      .select()
      .from(referralRewards)
      .where(eq(referralRewards.userId, userId))
      .orderBy(desc(referralRewards.grantedAt))
      .limit(limit);
  }

  /**
   * Number of users who signed up with this user as their inviter.
   * Distinct from `countRewardsForUser` because the inviter receives a
   * reward row per invitee — the two counters happen to be equal in
   * the current implementation but stay decoupled in case a future
   * reward type doesn't grant per-invitee.
   */
  async countInviteesForUser(userId: string): Promise<number> {
    const [row] = await this.db
      .getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.referredByUserId, userId));
    return row?.count ?? 0;
  }
}
