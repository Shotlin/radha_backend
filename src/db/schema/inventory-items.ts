import {
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { auditColumns, baseColumns, softDeleteColumn } from './_base';

/**
 * BE-27 — Current stock position per (tenant, store, product).
 *
 * Single denormalised row for fast dashboard reads. Authoritative
 * sum-of-batches lives in `inventory_batches`; when a batch row
 * changes, the service layer rewrites this row inside the same
 * transaction so the two stay in lockstep.
 *
 * `availableQuantity = quantity - reservedQuantity`. Reserved is a
 * BE-28 hook (cart / hold) — defaults to 0 today. We persist it now
 * to avoid a future schema bump.
 *
 * `isLowStock` is a 0/1 flag mirrored from `low_stock_rules` plus the
 * current quantity, kept in sync by `LowStockAlertService`. We use a
 * smallint-flavoured integer rather than a boolean because the rest
 * of the codebase prefers numeric flags for partial-index friendliness.
 */
export const inventoryItems = pgTable(
  'inventory_items',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    productId: uuid('product_id').notNull(),

    quantity: integer('quantity').notNull().default(0),
    reservedQuantity: integer('reserved_quantity').notNull().default(0),
    availableQuantity: integer('available_quantity').notNull().default(0),

    lowStockThreshold: integer('low_stock_threshold'),
    isLowStock: integer('is_low_stock').notNull().default(0),

    lastMovementAt: timestamp('last_movement_at', { withTimezone: true }),
    lastInAt: timestamp('last_in_at', { withTimezone: true }),
    lastOutAt: timestamp('last_out_at', { withTimezone: true }),

    totalIn: integer('total_in').notNull().default(0),
    totalOut: integer('total_out').notNull().default(0),

    averageUnitCost: decimal('average_unit_cost', { precision: 10, scale: 2 }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    productStoreUniq: uniqueIndex('uniq_inventory_product_store').on(t.productId, t.storeId),
    tenantStoreIdx: index('idx_inventory_tenant_store').on(t.tenantId, t.storeId),
    storeIdx: index('idx_inventory_store').on(t.storeId),
    lowStockIdx: index('idx_inventory_low_stock').on(t.storeId, t.isLowStock),
  }),
);

export type InventoryItemRow = typeof inventoryItems.$inferSelect;
export type NewInventoryItem = typeof inventoryItems.$inferInsert;
