import { date, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { baseColumns } from './_base';

/**
 * BE-38 — Consumer saved products with expiry tracking.
 *
 * Each consumer can save products they purchase and track expiry dates.
 * Premium consumers share products across family members.
 */
export const savedProducts = pgTable(
  'saved_products',
  {
    ...baseColumns,
    userId: uuid('user_id').notNull(),
    productName: text('product_name').notNull(),
    productId: uuid('product_id'),
    barcode: text('barcode'),
    expiresAt: date('expires_at'),
    markedConsumedAt: timestamp('marked_consumed_at', { withTimezone: true }),
    notes: text('notes'),
  },
  (table) => ({
    userExpiresIdx: index('idx_saved_products_user_expires')
      .on(table.userId, table.expiresAt)
      .where(sql`marked_consumed_at IS NULL`),
    userIdIdx: index('idx_saved_products_user_id').on(table.userId),
  }),
);

export type SavedProductRow = typeof savedProducts.$inferSelect;
export type SavedProductInsert = typeof savedProducts.$inferInsert;
