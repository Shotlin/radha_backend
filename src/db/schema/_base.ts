import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Reusable column groups every BE-05+ schema file should compose into
 * its tables. Keeps audit fields, soft-delete, and tenant scoping
 * uniform across the entire database.
 */

/** id, created_at, updated_at — required on every table. */
export const baseColumns = {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
};

/** Adds a `deleted_at` column. `BaseRepository.softDelete()` uses this. */
export const softDeleteColumn = {
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};

/** Adds created_by / updated_by / deleted_by user-id audit columns. */
export const auditColumns = {
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  deletedBy: uuid('deleted_by'),
};

/** Tenant-scoped tables MUST include this and be policy-protected (BE-09). */
export const tenantScopeColumn = {
  tenantId: uuid('tenant_id').notNull(),
};

/** Store-scoped tables sit under tenant scope and add a store filter. */
export const storeScopeColumn = {
  storeId: uuid('store_id').notNull(),
};
