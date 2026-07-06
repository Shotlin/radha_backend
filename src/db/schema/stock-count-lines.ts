import { index, integer, jsonb, pgTable, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-27 — Per-product line inside a stock count.
 *
 * `systemQuantity` is the inventory_items.quantity captured at the
 * moment the line was recorded (so reviewers see what the count
 * differed from), and `countedQuantity` is the value entered by the
 * counting staff. `variance = countedQuantity - systemQuantity`,
 * persisted because we never want to recompute it after the count is
 * completed (the system quantity at that future moment may differ).
 *
 * Cascade-delete on stock_count_id keeps the count + lines in lockstep.
 */
export const stockCountLines = pgTable(
  'stock_count_lines',
  {
    ...baseColumns,
    stockCountId: uuid('stock_count_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    productId: uuid('product_id').notNull(),

    systemQuantity: integer('system_quantity').notNull(),
    countedQuantity: integer('counted_quantity').notNull(),
    variance: integer('variance').notNull(),

    notes: varchar('notes', { length: 500 }),

    /** Set once the count is completed and an adjustment movement is
     *  emitted for this line. NULL while the count is in progress. */
    adjustmentMovementId: uuid('adjustment_movement_id'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    stockCountIdx: index('idx_stock_count_lines_count').on(t.stockCountId),
    productIdx: index('idx_stock_count_lines_product').on(t.productId),
    /** A single product appears at most once per count. */
    countProductUniq: uniqueIndex('uniq_stock_count_lines_count_product').on(
      t.stockCountId,
      t.productId,
    ),
  }),
);

export type StockCountLineRow = typeof stockCountLines.$inferSelect;
export type NewStockCountLine = typeof stockCountLines.$inferInsert;
