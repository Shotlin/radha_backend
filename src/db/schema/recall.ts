import { sql } from 'drizzle-orm';
import {
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { savedProducts } from './saved-products';
import { tenants } from './tenants';
import { users } from './users';

/**
 * BE-39 — Recall Alert Sweep + FSSAI Feed.
 *
 * Two tables ship together:
 *
 *   - `recall_feed_entries` — denormalised cache of upstream
 *     government feed rows (FSSAI today, more publishers later).
 *     `raw` keeps the untransformed publisher payload so we can
 *     re-process with new matching rules without re-fetching.
 *
 *   - `recall_alerts` — per-user materialised view of "you own a
 *     product that was just recalled". Idempotent on
 *     `(user_id, recall_feed_entry_id, saved_product_id)` so that
 *     a sweep that runs twice (or backfills historical entries)
 *     doesn't spam the same person.
 *
 * `acknowledged_at` lets the Mobile_App move acknowledged alerts to
 * a "history" tab without deleting the row — auditors need to see
 * what was surfaced.
 */
export const recallFeedEntries = pgTable(
  'recall_feed_entries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    source: text('source').notNull(),
    ean: text('ean'),
    brand: text('brand'),
    productName: text('product_name'),
    batchNumber: text('batch_number'),
    reason: text('reason').notNull(),
    recalledAt: date('recalled_at').notNull(),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    byEan: index('idx_recall_feed_ean').on(t.ean),
    bySourceRecalledAt: index('idx_recall_feed_source_recalled_at').on(t.source, t.recalledAt),
  }),
);

export type RecallFeedEntryRow = typeof recallFeedEntries.$inferSelect;
export type NewRecallFeedEntry = typeof recallFeedEntries.$inferInsert;

export const recallAlerts = pgTable(
  'recall_alerts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    savedProductId: uuid('saved_product_id').references(() => savedProducts.id, {
      onDelete: 'cascade',
    }),
    recallFeedEntryId: uuid('recall_feed_entry_id')
      .notNull()
      .references(() => recallFeedEntries.id, { onDelete: 'cascade' }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    byUserCreated: index('idx_recall_alerts_user_created').on(t.userId, t.createdAt),
    byTenantUser: index('idx_recall_alerts_tenant_user').on(t.tenantId, t.userId),
    uniqueUserEntryProduct: uniqueIndex('recall_alerts_user_entry_product_unique').on(
      t.userId,
      t.recallFeedEntryId,
      t.savedProductId,
    ),
  }),
);

export type RecallAlertRow = typeof recallAlerts.$inferSelect;
export type NewRecallAlert = typeof recallAlerts.$inferInsert;
