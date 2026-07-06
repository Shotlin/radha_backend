import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { users } from './users';

/**
 * BE-55 — Shopping List schema.
 *
 * Two tables:
 *   - `shopping_lists`       — per-user named lists. `archived_at`
 *                              flags soft-archived lists; the
 *                              partial `idx_shopping_lists_user_active`
 *                              keeps "list my active lists" cheap.
 *   - `shopping_list_items`  — line items for a list. `is_purchased`
 *                              is the tick state, `position` the
 *                              display order, and `deleted_at` a
 *                              soft delete. The partial index on
 *                              `(list_id, position) WHERE deleted_at
 *                              IS NULL` covers the hot read path
 *                              (`GET /shopping-lists/:id`).
 *
 * Scope is per-user (consumer feature) — no `tenant_id` column.
 * `ON DELETE CASCADE` on both FKs means deleting the user or the
 * parent list automatically prunes everything beneath it.
 */

export const shoppingLists = pgTable(
  'shopping_lists',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default('My Shopping List'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => ({
    userActiveIdx: index('idx_shopping_lists_user_active')
      .on(t.userId)
      .where(sql`${t.archivedAt} is null`),
  }),
);

export type ShoppingListRow = typeof shoppingLists.$inferSelect;
export type NewShoppingList = typeof shoppingLists.$inferInsert;

export const shoppingListItems = pgTable(
  'shopping_list_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    listId: uuid('list_id')
      .notNull()
      .references(() => shoppingLists.id, { onDelete: 'cascade' }),
    item: text('item').notNull(),
    quantity: text('quantity'),
    notes: text('notes'),
    isPurchased: boolean('is_purchased').notNull().default(false),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    listPositionIdx: index('idx_shopping_list_items_list')
      .on(t.listId, t.position)
      .where(sql`${t.deletedAt} is null`),
  }),
);

export type ShoppingListItemRow = typeof shoppingListItems.$inferSelect;
export type NewShoppingListItem = typeof shoppingListItems.$inferInsert;
