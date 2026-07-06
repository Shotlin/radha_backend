import { sql } from 'drizzle-orm';
import {
  boolean,
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

/**
 * BE-18 — Expiry tracking, thresholds, alerts.
 *
 * Three tables in one file because they share lifecycle:
 *   - `expiry_records`     — one row per (product, store, batch) instance
 *   - `expiry_thresholds`  — per-category yellow/red day windows
 *   - `expiry_alerts`      — actionable alerts for items in yellow/red
 *
 * Tenant scoping is required everywhere (no globals — expiry is
 * always tenant-specific). The BE-24 daily cron uses the indexes
 * declared here for efficient `(storeId, status, expiryDate)` reads.
 */

export const expiryRecordStatusEnum = pgEnum('expiry_record_status', [
  'green',
  'yellow',
  'red',
  'expired',
  'unknown',
]);

export const expirySourceEnum = pgEnum('expiry_source', ['scan', 'grn', 'manual', 'ocr']);

export const expiryAlertResolutionEnum = pgEnum('expiry_alert_resolution', [
  'discounted',
  'sold',
  'removed',
  'returned',
  'donated',
  'discarded',
]);

export const expiryRecords = pgTable(
  'expiry_records',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    productId: uuid('product_id').notNull(),

    expiryDate: timestamp('expiry_date', { withTimezone: true }).notNull(),
    manufactureDate: timestamp('manufacture_date', { withTimezone: true }),

    batchNumber: varchar('batch_number', { length: 100 }),

    quantity: integer('quantity').notNull().default(1),
    remainingQuantity: integer('remaining_quantity').notNull(),

    /**
     * Denormalised status — refreshed by BE-24's daily cron + on
     * write. Always check `daysRemaining` against the read time when
     * extreme accuracy matters; the indexed status field is for
     * filtering the 99% case.
     */
    status: expiryRecordStatusEnum('status').notNull().default('unknown'),
    daysRemaining: integer('days_remaining'),
    lastStatusUpdate: timestamp('last_status_update', { withTimezone: true })
      .notNull()
      .default(sql`now()`),

    source: expirySourceEnum('source').notNull(),
    sourceId: uuid('source_id'),

    shelfLocation: varchar('shelf_location', { length: 100 }),
    notes: varchar('notes', { length: 500 }),

    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionType: expiryAlertResolutionEnum('resolution_type'),
    resolutionNotes: varchar('resolution_notes', { length: 500 }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    storeStatusDateIdx: index('expiry_store_status_date_idx').on(t.storeId, t.status, t.expiryDate),
    productStoreIdx: index('expiry_product_store_idx').on(t.productId, t.storeId),
    expiryDateIdx: index('expiry_date_idx').on(t.expiryDate),
    batchIdx: index('expiry_batch_idx').on(t.batchNumber),
    tenantIdx: index('expiry_tenant_idx').on(t.tenantId),
  }),
);

export type ExpiryRecordRow = typeof expiryRecords.$inferSelect;
export type NewExpiryRecord = typeof expiryRecords.$inferInsert;

export const expiryThresholds = pgTable(
  'expiry_thresholds',
  {
    ...baseColumns,
    ...auditColumns,
    /** `tenantId IS NULL` rows are the platform defaults from BE-18. */
    tenantId: uuid('tenant_id'),

    category: varchar('category', { length: 100 }).notNull(),
    yellowDays: integer('yellow_days').notNull().default(30),
    redDays: integer('red_days').notNull().default(7),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantCategoryUniq: uniqueIndex('expiry_thresholds_tenant_category_uniq').on(
      t.tenantId,
      t.category,
    ),
    categoryIdx: index('expiry_thresholds_category_idx').on(t.category),
  }),
);

export type ExpiryThresholdRow = typeof expiryThresholds.$inferSelect;
export type NewExpiryThreshold = typeof expiryThresholds.$inferInsert;

export const expiryAlerts = pgTable(
  'expiry_alerts',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    expiryRecordId: uuid('expiry_record_id').notNull(),
    productId: uuid('product_id').notNull(),

    /** Status carried at the moment of generation (`yellow` | `red`). */
    status: expiryRecordStatusEnum('status').notNull(),
    daysRemaining: integer('days_remaining'),
    quantity: integer('quantity').notNull(),

    isAcknowledged: boolean('is_acknowledged').notNull().default(false),
    acknowledgedBy: uuid('acknowledged_by'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedNotes: varchar('acknowledged_notes', { length: 500 }),

    isResolved: boolean('is_resolved').notNull().default(false),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: expiryAlertResolutionEnum('resolution'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    storeActiveIdx: index('expiry_alerts_store_active_idx').on(
      t.storeId,
      t.isAcknowledged,
      t.isResolved,
    ),
    statusIdx: index('expiry_alerts_status_idx').on(t.status),
    expiryRecordIdx: index('expiry_alerts_expiry_record_idx').on(t.expiryRecordId),
    /**
     * Partial uniqueness: at most one **active** (unresolved) alert per
     * `(expiry_record_id, status)` so generators are idempotent —
     * they can blindly create-if-missing without worrying about the
     * inserts racing.
     */
    activePerRecordUniq: uniqueIndex('expiry_alerts_active_per_record_uniq')
      .on(t.expiryRecordId, t.status)
      .where(sql`is_resolved = false`),
  }),
);

export type ExpiryAlertRow = typeof expiryAlerts.$inferSelect;
export type NewExpiryAlert = typeof expiryAlerts.$inferInsert;
