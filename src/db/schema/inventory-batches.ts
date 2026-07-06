import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-27 — Per-batch quantity inside a single inventory_item.
 *
 *   one inventory_item ─< many inventory_batches
 *
 * A batch is identified by (productId, storeId, batchNumber). Same
 * product + store with NO batch number can have multiple "unbatched"
 * rows — typically only one, but the schema allows N for ad-hoc
 * stock-in flows (manual additions without a printed batch).
 *
 * `expiryDate` drives FIFO ordering: oldest expiry is consumed first
 * when a stock_out request doesn't pin a specific batch. Rows with
 * NULL expiry are consumed last (no expiry signal → assume freshest).
 */
export const inventoryBatches = pgTable(
  'inventory_batches',
  {
    ...baseColumns,
    inventoryItemId: uuid('inventory_item_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    productId: uuid('product_id').notNull(),

    batchNumber: varchar('batch_number', { length: 100 }),

    quantity: integer('quantity').notNull().default(0),

    expiryDate: timestamp('expiry_date', { withTimezone: true }),
    manufactureDate: timestamp('manufacture_date', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),

    /** `'grn' | 'manual' | 'transfer' | 'count'`. Not an enum because
     *  BE-28 may add `'return' | 'sample'` without a migration. */
    sourceType: varchar('source_type', { length: 30 }),
    sourceId: uuid('source_id'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    inventoryItemIdx: index('idx_batches_inventory_item').on(t.inventoryItemId),
    productStoreIdx: index('idx_batches_product_store').on(t.productId, t.storeId),
    expiryIdx: index('idx_batches_expiry').on(t.expiryDate),
    /**
     * Storage-level guard: same product + store + named batch can't
     * appear twice. Items without a batch number are allowed to
     * repeat (NULL never equals NULL in unique indexes anyway, but
     * we make it explicit with a partial index).
     */
    productStoreBatchUniq: uniqueIndex('uniq_batches_product_store_batch')
      .on(t.productId, t.storeId, t.batchNumber)
      .where(sql`batch_number IS NOT NULL`),
  }),
);

export type InventoryBatchRow = typeof inventoryBatches.$inferSelect;
export type NewInventoryBatch = typeof inventoryBatches.$inferInsert;
