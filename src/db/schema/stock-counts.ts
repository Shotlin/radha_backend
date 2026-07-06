import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { auditColumns, baseColumns } from './_base';

/**
 * BE-27 — Physical stock count session header.
 *
 * Lifecycle:
 *   in_progress → completed
 *               → cancelled
 *
 * On completion, each `stock_count_lines` row is compared against the
 * `inventory_items.quantity` of the moment, and a `stock_movements`
 * adjustment is emitted for every variance. This is the audit trail
 * for shrinkage / theft / data-entry errors.
 */
export const stockCountStatusEnum = pgEnum('stock_count_status', [
  'in_progress',
  'completed',
  'cancelled',
]);

export const stockCounts = pgTable(
  'stock_counts',
  {
    ...baseColumns,
    ...auditColumns,
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),

    status: stockCountStatusEnum('status').notNull().default('in_progress'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

    notes: varchar('notes', { length: 1000 }),

    /** Denormalised stats — refreshed on `complete()`. */
    totalProducts: integer('total_products').notNull().default(0),
    variances: integer('variances').notNull().default(0),
    totalVarianceQuantity: integer('total_variance_quantity').notNull().default(0),
    adjustmentsCreated: integer('adjustments_created').notNull().default(0),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantStoreIdx: index('idx_stock_counts_tenant_store').on(t.tenantId, t.storeId),
    storeStatusIdx: index('idx_stock_counts_store_status').on(t.storeId, t.status),
    startedAtIdx: index('idx_stock_counts_started').on(t.startedAt),
  }),
);

export type StockCountRow = typeof stockCounts.$inferSelect;
export type NewStockCount = typeof stockCounts.$inferInsert;
