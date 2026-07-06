import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { users } from './users';

/**
 * BE-43 — Referral Program (Req 42).
 *
 * `referral_rewards` records every grant produced by the referral
 * service. Two rows are written per successful `applyReferralOnSignup`
 * call — one for the inviter, one for the invitee — both pointing at
 * the other party via `source_referral_user_id`.
 *
 * The table is intentionally NOT tenant-scoped: referral relationships
 * span tenants (a Consumer can refer a future Business Owner who later
 * spins up their own tenant) and rewards are a platform-level construct.
 *
 * Idempotency is enforced by the `(user_id, source_referral_user_id, reward_type)`
 * unique index. Re-running the same apply silently no-ops.
 */
export const referralRewards = pgTable(
  'referral_rewards',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceReferralUserId: uuid('source_referral_user_id')
      .notNull()
      .references(() => users.id),
    rewardType: text('reward_type').notNull().default('premium_consumer_month'),
    grantedAt: timestamp('granted_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    appliedToSubscriptionId: uuid('applied_to_subscription_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    uniquePerPair: uniqueIndex('referral_rewards_unique_pair').on(
      t.userId,
      t.sourceReferralUserId,
      t.rewardType,
    ),
    byUser: index('referral_rewards_user_idx').on(t.userId),
    bySource: index('referral_rewards_source_idx').on(t.sourceReferralUserId),
  }),
);

export type ReferralRewardRow = typeof referralRewards.$inferSelect;
export type NewReferralReward = typeof referralRewards.$inferInsert;
