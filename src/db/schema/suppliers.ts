import { sql } from 'drizzle-orm';
import {
  boolean,
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
 * BE-25 — Suppliers / vendor directory.
 *
 * Three tables in a single schema file (mirrors the BE-09 / BE-19
 * convention) because they share lifecycle and ship in one migration:
 *
 *   - `suppliers`            — tenant-scoped vendor master record.
 *                              Carries Indian-compliance fields
 *                              (GST + PAN), classification, primary
 *                              contact, address, business terms, and
 *                              a small set of *denormalised*
 *                              performance counters that get
 *                              refreshed by `SupplierPerformanceService`
 *                              when GRNs are posted (BE-26).
 *
 *   - `supplier_contacts`    — many contacts per supplier (sales /
 *                              accounting / delivery). One contact
 *                              may be flagged primary; the partial
 *                              unique index enforces that.
 *
 *   - `supplier_performance` — append-only ledger of per-GRN
 *                              metrics (delivery days, expiry
 *                              remaining at delivery, short-shelf
 *                              flag, amount). Aggregated by
 *                              `SupplierPerformanceService` to
 *                              compute reliability + quality scores.
 *
 * Status workflow (`supplier_status`):
 *
 *     pending ─→ active ─→ inactive
 *               │
 *               └→ blacklisted   (terminal-ish — admin can revert)
 *
 * Tenant scoping is mandatory on `suppliers`; `supplier_contacts`
 * and `supplier_performance` inherit visibility through their
 * parent supplier via cascade FKs.
 */

export const supplierStatusEnum = pgEnum('supplier_status', [
  'active',
  'inactive',
  'blacklisted',
  'pending',
]);

/* ─────────────────── suppliers ─────────────────── */

export const suppliers = pgTable(
  'suppliers',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    tenantId: uuid('tenant_id').notNull(),

    // Identity ----------------------------------------------------
    name: varchar('name', { length: 200 }).notNull(),
    legalName: varchar('legal_name', { length: 200 }),
    /** User-friendly identifier auto-generated when omitted. */
    code: varchar('code', { length: 50 }).notNull(),

    // Indian compliance ------------------------------------------
    gstNumber: varchar('gst_number', { length: 15 }),
    panNumber: varchar('pan_number', { length: 10 }),

    // Classification ---------------------------------------------
    category: varchar('category', { length: 100 }),
    description: varchar('description', { length: 1000 }),

    // Status -----------------------------------------------------
    status: supplierStatusEnum('status').notNull().default('pending'),
    blacklistReason: varchar('blacklist_reason', { length: 500 }),
    blacklistedAt: timestamp('blacklisted_at', { withTimezone: true }),

    // Primary contact -------------------------------------------
    email: varchar('email', { length: 255 }),
    phone: varchar('phone', { length: 20 }),
    alternatePhone: varchar('alternate_phone', { length: 20 }),
    whatsappNumber: varchar('whatsapp_number', { length: 20 }),

    // Address ---------------------------------------------------
    addressLine1: varchar('address_line_1', { length: 255 }),
    addressLine2: varchar('address_line_2', { length: 255 }),
    city: varchar('city', { length: 100 }),
    state: varchar('state', { length: 100 }),
    pincode: varchar('pincode', { length: 10 }),
    country: varchar('country', { length: 2 }).notNull().default('IN'),

    // Business terms --------------------------------------------
    /** e.g. "Net 30", "COD", "Advance 50%". Free-form on purpose. */
    paymentTerms: varchar('payment_terms', { length: 100 }),
    /** Typical lead time in days. */
    deliveryDays: integer('delivery_days'),
    /** Minimum order value. ₹ stored as numeric (12,2). */
    minimumOrderAmount: decimal('minimum_order_amount', { precision: 12, scale: 2 }),

    // Performance (denormalised — refreshed via SupplierPerformanceService)
    totalGrns: integer('total_grns').notNull().default(0),
    averageDeliveryDays: decimal('average_delivery_days', { precision: 5, scale: 2 }),
    qualityScore: integer('quality_score'), // 0-100
    reliabilityScore: integer('reliability_score'), // 0-100
    shortShelfLifeIncidents: integer('short_shelf_life_incidents').notNull().default(0),
    lastDeliveryDate: timestamp('last_delivery_date', { withTimezone: true }),
    totalAmountDelivered: decimal('total_amount_delivered', {
      precision: 14,
      scale: 2,
    })
      .notNull()
      .default('0'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantIdx: index('idx_suppliers_tenant').on(t.tenantId),
    tenantStatusIdx: index('idx_suppliers_tenant_status').on(t.tenantId, t.status),
    nameIdx: index('idx_suppliers_name').on(t.name),
    cityIdx: index('idx_suppliers_city').on(t.city),
    gstIdx: index('idx_suppliers_gst').on(t.gstNumber),
    /**
     * Per-tenant uniqueness for `code`. Soft-deleted rows excluded so
     * a deleted supplier's code can be reused (or restored) without
     * collision.
     */
    tenantCodeUniq: uniqueIndex('idx_suppliers_tenant_code_uniq')
      .on(t.tenantId, t.code)
      .where(sql`deleted_at IS NULL`),
    /** GST is unique within a tenant when supplied. */
    tenantGstUniq: uniqueIndex('idx_suppliers_tenant_gst_uniq')
      .on(t.tenantId, t.gstNumber)
      .where(sql`gst_number IS NOT NULL AND deleted_at IS NULL`),
  }),
);

export type SupplierRow = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;

/* ─────────────────── supplier_contacts ─────────────────── */

export const supplierContacts = pgTable(
  'supplier_contacts',
  {
    ...baseColumns,
    ...softDeleteColumn,
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull(),

    name: varchar('name', { length: 100 }).notNull(),
    designation: varchar('designation', { length: 100 }),
    email: varchar('email', { length: 255 }),
    phone: varchar('phone', { length: 20 }),

    isPrimary: boolean('is_primary').notNull().default(false),
    notes: varchar('notes', { length: 500 }),
  },
  (t) => ({
    supplierIdx: index('idx_supplier_contacts_supplier').on(t.supplierId),
    tenantIdx: index('idx_supplier_contacts_tenant').on(t.tenantId),
    /**
     * At most one primary contact per supplier, enforced at the DB
     * level so a race between two add-contact calls can't end up
     * with two primaries.
     */
    primaryUniq: uniqueIndex('idx_supplier_contacts_primary_uniq')
      .on(t.supplierId)
      .where(sql`is_primary = true AND deleted_at IS NULL`),
  }),
);

export type SupplierContactRow = typeof supplierContacts.$inferSelect;
export type NewSupplierContact = typeof supplierContacts.$inferInsert;

/* ─────────────────── supplier_performance ─────────────────── */

export const supplierPerformance = pgTable(
  'supplier_performance',
  {
    ...baseColumns,
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull(),

    /** GRN this metric snapshot belongs to. Nullable until BE-26 wires GRN. */
    grnId: uuid('grn_id'),

    deliveryDays: integer('delivery_days').notNull().default(0),
    /** Min expiry-remaining-days across the GRN lines, in days. */
    expiryRemainingDays: integer('expiry_remaining_days'),
    /** True when ≥1 line had < 30 days remaining at delivery. */
    shortShelfLife: boolean('short_shelf_life').notNull().default(false),
    /** Optional delivered amount (₹). */
    amount: decimal('amount', { precision: 12, scale: 2 }),

    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    supplierIdx: index('idx_supplier_performance_supplier').on(t.supplierId),
    tenantIdx: index('idx_supplier_performance_tenant').on(t.tenantId),
    grnIdx: index('idx_supplier_performance_grn').on(t.grnId),
    recordedAtIdx: index('idx_supplier_performance_recorded_at').on(t.recordedAt),
  }),
);

export type SupplierPerformanceRow = typeof supplierPerformance.$inferSelect;
export type NewSupplierPerformance = typeof supplierPerformance.$inferInsert;
