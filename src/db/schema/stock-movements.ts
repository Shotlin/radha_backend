import {
  decimal,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-27 — Append-only stock movement audit trail.
 *
 * Every change to `inventory_items.quantity` MUST emit one row here
 * inside the same transaction. Reads of this table never use a
 * range-only filter; the dashboard always scopes by store + date
 * range, and the line-item drill-down always scopes by product.
 *
 * `quantity` carries the signed delta:
 *   `in` movements have positive quantity,
 *   `out` movements have negative quantity,
 *   `adjustment` movements use the signed delta needed to reach the
 *   new total (positive for upward correction, negative for downward).
 *
 * `quantityBefore` / `quantityAfter` capture the inventory_item total
 * before and after the movement so we can reconstruct stock at any
 * point in time without replaying every movement.
 */

export const stockMovementTypeEnum = pgEnum('stock_movement_type', [
  'in',
  'out',
  'adjustment',
  'transfer',
]);

export const stockMovementReasonEnum = pgEnum('stock_movement_reason', [
  'grn_post',
  'grn_reversal',
  'manual_in',
  'sale',
  'expired',
  'damaged',
  'returned',
  'theft',
  'count_adjustment',
  'correction',
]);

export const stockMovements = pgTable(
  'stock_movements',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    productId: uuid('product_id').notNull(),
    inventoryItemId: uuid('inventory_item_id'),

    type: stockMovementTypeEnum('type').notNull(),
    reason: stockMovementReasonEnum('reason').notNull(),

    quantity: integer('quantity').notNull(),
    quantityBefore: integer('quantity_before').notNull(),
    quantityAfter: integer('quantity_after').notNull(),

    batchNumber: varchar('batch_number', { length: 100 }),
    inventoryBatchId: uuid('inventory_batch_id'),

    /** `'grn' | 'manual' | 'count' | 'sale' | 'other'`. Free-text by
     *  design: BE-28 may need to introduce new sources without a
     *  migration. */
    sourceType: varchar('source_type', { length: 30 }),
    sourceId: uuid('source_id'),

    unitCost: decimal('unit_cost', { precision: 10, scale: 2 }),
    totalCost: decimal('total_cost', { precision: 14, scale: 2 }),

    userId: uuid('user_id').notNull(),

    notes: varchar('notes', { length: 500 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    productStoreCreatedIdx: index('idx_movements_product_store_created').on(
      t.productId,
      t.storeId,
      t.createdAt,
    ),
    storeCreatedIdx: index('idx_movements_store_created').on(t.storeId, t.createdAt),
    tenantCreatedIdx: index('idx_movements_tenant_created').on(t.tenantId, t.createdAt),
    typeIdx: index('idx_movements_type').on(t.type),
    sourceIdx: index('idx_movements_source').on(t.sourceType, t.sourceId),
  }),
);

export type StockMovementRow = typeof stockMovements.$inferSelect;
export type NewStockMovement = typeof stockMovements.$inferInsert;
