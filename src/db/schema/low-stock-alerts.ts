import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-27 — Active and historical low-stock alerts.
 *
 * One row per alert event. Lifecycle:
 *
 *   created  — `resolvedAt = NULL`
 *   resolved — `resolvedAt` stamped when stock rises back above the
 *              threshold or the rule is disabled
 *
 * The partial unique index on `(productId, storeId) WHERE
 * resolved_at IS NULL` guarantees at most one open alert per
 * (product, store) so we never spam users with duplicate
 * notifications.
 */
export const lowStockAlerts = pgTable(
  'low_stock_alerts',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    productId: uuid('product_id').notNull(),
    inventoryItemId: uuid('inventory_item_id'),

    threshold: integer('threshold').notNull(),
    currentQuantity: integer('current_quantity').notNull(),

    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantStoreIdx: index('idx_low_stock_alerts_tenant_store').on(t.tenantId, t.storeId),
    storeProductIdx: index('idx_low_stock_alerts_store_product').on(t.storeId, t.productId),
    activeUniq: uniqueIndex('uniq_low_stock_alerts_active')
      .on(t.productId, t.storeId)
      .where(sql`resolved_at IS NULL`),
  }),
);

export type LowStockAlertRow = typeof lowStockAlerts.$inferSelect;
export type NewLowStockAlert = typeof lowStockAlerts.$inferInsert;
