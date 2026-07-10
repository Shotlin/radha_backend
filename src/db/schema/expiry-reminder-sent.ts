import { index, pgTable, smallint, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-B4 (Phase 10) — Expiry-reminder dedupe table.
 *
 * One row per (user_id, expiry_record_id, window) triplet. The 03:00 UTC
 * expiry-reminders cron inserts here after sending each push; a UNIQUE
 * conflict means the notification was already delivered for that window and
 * the cron silently skips it.
 *
 * `window` encodes the reminder bucket in days: 7 | 2 | 0.
 * No tenant_id column — resolved at query time from expiry_records.
 */
export const expiryReminderSent = pgTable(
  'expiry_reminder_sent',
  {
    ...baseColumns,
    userId: uuid('user_id').notNull(),
    expiryRecordId: uuid('expiry_record_id').notNull(),
    window: smallint('window').notNull(), // 7 | 2 | 0
  },
  (t) => ({
    uniq: uniqueIndex('expiry_reminder_sent_uniq').on(t.userId, t.expiryRecordId, t.window),
    recordIdx: index('expiry_reminder_record_idx').on(t.expiryRecordId),
  }),
);

export type ExpiryReminderSentRow = typeof expiryReminderSent.$inferSelect;
export type NewExpiryReminderSent = typeof expiryReminderSent.$inferInsert;
