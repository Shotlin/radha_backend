import { sql } from 'drizzle-orm';
import {
  decimal,
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
 * BE-16 — Scan session + scan item schema.
 *
 * Two tables sharing one file because the lifecycle is unified:
 * sessions cannot exist without items in any meaningful sense, and
 * the API surface presents them as a single nested resource.
 *
 *   scan_sessions  — one row per scanning session (audit, shelf-check, …)
 *   scan_items     — one row per individual scan inside a session
 *
 * Tenant scoping is mandatory on both. BE-08 guard stack enforces
 * that callers cannot read or write across tenants.
 */

export const scanSessionTypeEnum = pgEnum('scan_session_type', [
  'audit',
  'shelf-check',
  'expiry-check',
  'inventory',
  'training',
  'general',
]);

export const scanSessionStatusEnum = pgEnum('scan_session_status', [
  'active',
  'completed',
  'abandoned',
  'expired',
]);

export const expiryStatusEnum = pgEnum('expiry_status', ['green', 'yellow', 'red', 'unknown']);

export const eanMatchStatusEnum = pgEnum('ean_match_status', [
  'matched',
  'unmatched',
  'no_list',
  'invalid',
  'unchecked',
]);

export const scanSessions = pgTable(
  'scan_sessions',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    userId: uuid('user_id').notNull(),

    type: scanSessionTypeEnum('type').notNull().default('general'),
    status: scanSessionStatusEnum('status').notNull().default('active'),

    taskId: uuid('task_id'),
    eanListId: uuid('ean_list_id'),

    /**
     * Denormalised counters maintained by `ScanItemsService` on every
     * record/remove. `ScanSessionService.refreshSessionStats` is the
     * canonical re-read path used at session-end and by the BE-24
     * stale-session sweep so any drift is corrected.
     */
    totalScans: integer('total_scans').notNull().default(0),
    uniqueProducts: integer('unique_products').notNull().default(0),
    matchedEans: integer('matched_eans').notNull().default(0),
    unmatchedEans: integer('unmatched_eans').notNull().default(0),
    expiredItems: integer('expired_items').notNull().default(0),
    nearExpiryItems: integer('near_expiry_items').notNull().default(0),

    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    durationSeconds: integer('duration_seconds'),

    startLatitude: decimal('start_latitude', { precision: 10, scale: 7 }),
    startLongitude: decimal('start_longitude', { precision: 10, scale: 7 }),

    deviceId: varchar('device_id', { length: 255 }),
    deviceModel: varchar('device_model', { length: 100 }),
    appVersion: varchar('app_version', { length: 32 }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantStoreIdx: index('scan_sessions_tenant_store_idx').on(t.tenantId, t.storeId),
    storeStartedIdx: index('scan_sessions_store_started_idx').on(t.storeId, t.startedAt),
    userStatusIdx: index('scan_sessions_user_status_idx').on(t.userId, t.status),
    statusIdx: index('scan_sessions_status_idx').on(t.status),
    typeIdx: index('scan_sessions_type_idx').on(t.tenantId, t.type),
    /**
     * Partial unique index to enforce **one active session per (user,
     * store)**. NULL `deletedAt` filter so soft-deleted sessions
     * don't conflict.
     *
     * Drizzle `pg-core` doesn't expose partial-unique declaratively;
     * `BE-16_scans` migration creates this with a raw SQL
     * `WHERE status = 'active' AND deleted_at IS NULL` clause. The
     * placeholder `uniqueIndex` here keeps the type-level intent
     * visible during a `drizzle-kit generate` diff.
     */
    activeUniqIdx: uniqueIndex('scan_sessions_one_active_per_user_store')
      .on(t.userId, t.storeId, t.status)
      .where(sql`status = 'active' AND deleted_at IS NULL`),
  }),
);

export type ScanSessionRow = typeof scanSessions.$inferSelect;
export type NewScanSession = typeof scanSessions.$inferInsert;

export const scanItems = pgTable(
  'scan_items',
  {
    ...baseColumns,
    ...softDeleteColumn,

    sessionId: uuid('session_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    userId: uuid('user_id').notNull(),

    ean: varchar('ean', { length: 13 }).notNull(),
    productId: uuid('product_id'),
    productNameSnapshot: varchar('product_name_snapshot', { length: 200 }),
    brandSnapshot: varchar('brand_snapshot', { length: 100 }),

    eanMatchStatus: eanMatchStatusEnum('ean_match_status').notNull().default('unchecked'),
    expiryStatus: expiryStatusEnum('expiry_status').notNull().default('unknown'),

    scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull(),
    expiryDate: timestamp('expiry_date', { withTimezone: true }),
    manufactureDate: timestamp('manufacture_date', { withTimezone: true }),
    batchNumber: varchar('batch_number', { length: 100 }),
    quantity: integer('quantity').notNull().default(1),
    shelfLocation: varchar('shelf_location', { length: 100 }),
    notes: varchar('notes', { length: 500 }),
    imageMediaId: uuid('image_media_id'),

    latitude: decimal('latitude', { precision: 10, scale: 7 }),
    longitude: decimal('longitude', { precision: 10, scale: 7 }),

    deviceId: varchar('device_id', { length: 255 }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),

    /**
     * BE-17 — Mobile-generated idempotency key. Together with
     * `sessionId` it forms the unique-per-session key used to dedupe
     * offline-sync replays. The partial unique index
     * `scan_items_session_client_uniq` (created in the BE-17
     * migration) excludes NULL values so existing scans without a
     * clientId don't conflict.
     */
    clientId: uuid('client_id'),
  },
  (t) => ({
    sessionIdx: index('scan_items_session_idx').on(t.sessionId, t.scannedAt),
    storeScannedIdx: index('scan_items_store_scanned_idx').on(t.storeId, t.scannedAt),
    eanIdx: index('scan_items_ean_idx').on(t.ean),
    productIdx: index('scan_items_product_idx').on(t.productId),
    matchStatusIdx: index('scan_items_match_status_idx').on(t.eanMatchStatus),
    expiryStatusIdx: index('scan_items_expiry_status_idx').on(t.expiryStatus),
    clientIdSessionUniq: uniqueIndex('scan_items_session_client_uniq')
      .on(t.sessionId, t.clientId)
      .where(sql`client_id IS NOT NULL`),
  }),
);

export type ScanItemRow = typeof scanItems.$inferSelect;
export type NewScanItem = typeof scanItems.$inferInsert;

/* ─────────────────── BE-17 — Sync batches ─────────────────── */

export const syncBatchStatusEnum = pgEnum('sync_batch_status', [
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'partial',
]);

export const scanSyncBatches = pgTable(
  'scan_sync_batches',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    userId: uuid('user_id').notNull(),

    status: syncBatchStatusEnum('status').notNull().default('queued'),

    totalItems: integer('total_items').notNull(),
    processedItems: integer('processed_items').notNull().default(0),
    succeededItems: integer('succeeded_items').notNull().default(0),
    failedItems: integer('failed_items').notNull().default(0),
    duplicateItems: integer('duplicate_items').notNull().default(0),

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    /** Capped at 100 entries by the BE-17 service to keep the row small. */
    errors: jsonb('errors').$type<unknown[]>().notNull().default([]),
    errorMessage: varchar('error_message', { length: 1000 }),

    deviceId: varchar('device_id', { length: 255 }),
    appVersion: varchar('app_version', { length: 32 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    sessionIdx: index('scan_sync_batches_session_idx').on(t.sessionId),
    statusIdx: index('scan_sync_batches_status_idx').on(t.status),
    userIdx: index('scan_sync_batches_user_idx').on(t.userId, t.createdAt),
    tenantIdx: index('scan_sync_batches_tenant_idx').on(t.tenantId, t.createdAt),
  }),
);

export type ScanSyncBatchRow = typeof scanSyncBatches.$inferSelect;
export type NewScanSyncBatch = typeof scanSyncBatches.$inferInsert;
