import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { auditColumns, baseColumns, softDeleteColumn } from './_base';

/**
 * BE-27 — Low-stock threshold configuration.
 *
 * Rules are scoped to a store and target either:
 *   - a specific product (`productId` set, `category` null), OR
 *   - a category (`category` set, `productId` null).
 *
 * Resolution order at lookup time (most-specific wins):
 *   1. product-level rule for (storeId, productId)
 *   2. category-level rule for (storeId, category)
 *   3. no rule → no alerts
 *
 * The (productId, storeId) and (category, storeId) unique partial
 * indexes guarantee at most one rule per scope.
 */
export const lowStockRules = pgTable(
  'low_stock_rules',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),

    productId: uuid('product_id'),
    category: varchar('category', { length: 100 }),

    threshold: integer('threshold').notNull(),
    enabled: integer('enabled').notNull().default(1),
    notes: varchar('notes', { length: 500 }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantStoreIdx: index('idx_low_stock_rules_tenant_store').on(t.tenantId, t.storeId),
    productStoreUniq: uniqueIndex('uniq_low_stock_rules_product_store')
      .on(t.productId, t.storeId)
      .where(sql`product_id IS NOT NULL AND deleted_at IS NULL`),
    categoryStoreUniq: uniqueIndex('uniq_low_stock_rules_category_store')
      .on(t.category, t.storeId)
      .where(sql`category IS NOT NULL AND deleted_at IS NULL`),
  }),
);

export type LowStockRuleRow = typeof lowStockRules.$inferSelect;
export type NewLowStockRule = typeof lowStockRules.$inferInsert;
