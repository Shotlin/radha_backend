import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { auditColumns, baseColumns, softDeleteColumn } from './_base';
import { products } from './products';

/**
 * BE-15 — EAN list metadata + items + import audit.
 *
 * Three tables co-located in this file because they share the same
 * lifecycle, and splitting them across files would just create three
 * 50-line files that always change together.
 *
 *   ean_lists         — versioned list metadata (draft/active/archived)
 *   ean_list_items    — individual EANs in a list (1 list : N items)
 *   import_batches    — async import job tracker (1 batch : N errors)
 *   ean_import_errors — per-row error log
 *
 * Tenant scoping is required for `ean_lists` and `import_batches`
 * (no globals — every list belongs to exactly one tenant). Items and
 * errors inherit visibility from their parent list/batch via the
 * cascade FKs.
 */

export const eanListStatusEnum = pgEnum('ean_list_status', ['draft', 'active', 'archived']);

export const importBatchStatusEnum = pgEnum('import_batch_status', [
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
]);

export const eanLists = pgTable(
  'ean_lists',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id'), // null = tenant-wide list

    name: varchar('name', { length: 200 }).notNull(),
    description: varchar('description', { length: 500 }),
    version: integer('version').notNull().default(1),

    status: eanListStatusEnum('status').notNull().default('draft'),

    sourceFileKey: varchar('source_file_key', { length: 500 }),
    sourceFileType: varchar('source_file_type', { length: 10 }),

    totalItems: integer('total_items').notNull().default(0),
    validatedItems: integer('validated_items').notNull().default(0),

    activatedAt: timestamp('activated_at', { withTimezone: true }),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantIdx: index('ean_lists_tenant_idx').on(t.tenantId),
    storeStatusIdx: index('ean_lists_store_status_idx').on(t.storeId, t.status),
    statusIdx: index('ean_lists_status_idx').on(t.status),
  }),
);

export type EanListRow = typeof eanLists.$inferSelect;
export type NewEanList = typeof eanLists.$inferInsert;

export const eanListItems = pgTable(
  'ean_list_items',
  {
    ...baseColumns,
    listId: uuid('list_id')
      .notNull()
      .references(() => eanLists.id, { onDelete: 'cascade' }),
    ean: varchar('ean', { length: 13 }).notNull(),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),

    productName: varchar('product_name', { length: 200 }),
    brand: varchar('brand', { length: 100 }),
    notes: varchar('notes', { length: 500 }),

    rowNumber: integer('row_number'),
    rawData: jsonb('raw_data').$type<Record<string, unknown>>(),
  },
  (t) => ({
    listEanUniq: uniqueIndex('ean_list_items_list_ean_uniq').on(t.listId, t.ean),
    eanIdx: index('ean_list_items_ean_idx').on(t.ean),
    productIdx: index('ean_list_items_product_idx').on(t.productId),
  }),
);

export type EanListItemRow = typeof eanListItems.$inferSelect;
export type NewEanListItem = typeof eanListItems.$inferInsert;

export const importBatches = pgTable(
  'import_batches',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id').notNull(),
    listId: uuid('list_id').references(() => eanLists.id, { onDelete: 'set null' }),

    importedBy: uuid('imported_by').notNull(),

    fileKey: varchar('file_key', { length: 500 }),
    fileName: varchar('file_name', { length: 255 }),
    fileType: varchar('file_type', { length: 10 }),
    fileSize: integer('file_size'),

    status: importBatchStatusEnum('status').notNull().default('queued'),

    totalRows: integer('total_rows').notNull().default(0),
    processedRows: integer('processed_rows').notNull().default(0),
    validRows: integer('valid_rows').notNull().default(0),
    invalidRows: integer('invalid_rows').notNull().default(0),

    queuedAt: timestamp('queued_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    errorMessage: varchar('error_message', { length: 1000 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantIdx: index('import_batches_tenant_idx').on(t.tenantId),
    statusIdx: index('import_batches_status_idx').on(t.status),
    listIdx: index('import_batches_list_idx').on(t.listId),
  }),
);

export type ImportBatchRow = typeof importBatches.$inferSelect;
export type NewImportBatch = typeof importBatches.$inferInsert;

export const eanImportErrors = pgTable(
  'ean_import_errors',
  {
    ...baseColumns,
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    rowNumber: integer('row_number').notNull(),
    rawData: jsonb('raw_data').$type<Record<string, unknown>>(),
    errors: jsonb('errors').$type<string[]>().notNull().default([]),
  },
  (t) => ({
    batchIdx: index('ean_import_errors_batch_idx').on(t.batchId, t.rowNumber),
  }),
);

export type EanImportErrorRow = typeof eanImportErrors.$inferSelect;
export type NewEanImportError = typeof eanImportErrors.$inferInsert;
