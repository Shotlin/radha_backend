import { sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './users';

/**
 * BE-54 — `consumer_weekly_digests` schema.
 *
 * One row per (Consumer, week-starting Monday). The cron at
 * Sunday 08:00 IST computes the previous full week's stats,
 * inserts a row, fires a `daily-insights` FCM notification, and
 * stamps `delivered_at` on success.
 *
 * Failed sends leave `delivered_at NULL` so the partial
 * `idx_consumer_weekly_digests_undelivered` index can drive a
 * cheap retry sweep. The unique constraint on
 * `(user_id, week_starting)` makes the cron idempotent — a
 * second invocation in the same week is a no-op.
 *
 * `payload` is the entire summary JSON we'd hand to the Mobile_App
 * for in-app rendering (top products, savings, etc.). The
 * denormalised counters (`scans_count`, `high_sugar_count`, …)
 * exist so analytics queries don't have to JSONB-extract on every
 * read.
 */
export const consumerWeeklyDigests = pgTable(
  'consumer_weekly_digests',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    weekStarting: date('week_starting').notNull(),
    scansCount: integer('scans_count').notNull(),
    highSugarCount: integer('high_sugar_count').notNull(),
    recallCount: integer('recall_count').notNull(),
    alternativesRecommended: integer('alternatives_recommended').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => ({
    userWeekUnique: uniqueIndex('consumer_weekly_digests_user_week_unique').on(
      t.userId,
      t.weekStarting,
    ),
    undeliveredIdx: index('idx_consumer_weekly_digests_undelivered')
      .on(t.weekStarting)
      .where(sql`delivered_at IS NULL`),
  }),
);

export type ConsumerWeeklyDigestRow = typeof consumerWeeklyDigests.$inferSelect;
export type NewConsumerWeeklyDigest = typeof consumerWeeklyDigests.$inferInsert;
