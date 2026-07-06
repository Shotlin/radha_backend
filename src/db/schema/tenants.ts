import { sql } from 'drizzle-orm';
import {
  boolean,
  decimal,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { auditColumns, baseColumns, softDeleteColumn } from './_base';
import { users } from './users';

/**
 * Tenants & Stores schema (BE-09 + v2 ADDENDUM Req 41).
 *
 *   `tenants.kind = 'personal'` is the v2 personal-tenant slot used by
 *   every Consumer signup. `kind = 'business'` is the multi-store
 *   tenant created via BE-35 Business Activation.
 *
 *   Stores live only under business tenants; the schema doesn't
 *   enforce that (RLS in v2 ADDENDUM does), so application code MUST
 *   call `assertBusinessTenant(tenant)` before creating a store.
 */

export const tenantKindEnum = pgEnum('tenant_kind', ['business', 'personal']);

export const tenantStatusEnum = pgEnum('tenant_status', [
  'active',
  'trial',
  'suspended',
  'cancelled',
  'pending_setup',
]);

export const userStoreAccessLevelEnum = pgEnum('user_store_access_level', [
  'read',
  'write',
  'admin',
]);

export const tenants = pgTable(
  'tenants',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    name: varchar('name', { length: 200 }).notNull(),
    kind: tenantKindEnum('kind').notNull().default('business'),
    status: tenantStatusEnum('status').notNull().default('pending_setup'),
    subdomain: varchar('subdomain', { length: 50 }).unique(),
    slug: text('slug').unique(),
    plan: varchar('plan', { length: 50 }).notNull().default('trial'),
    industry: varchar('industry', { length: 100 }),
    country: varchar('country', { length: 2 }).notNull().default('IN'),
    timezone: varchar('timezone', { length: 50 }).notNull().default('Asia/Kolkata'),
    contactEmail: varchar('contact_email', { length: 255 }),
    contactMobile: varchar('contact_mobile', { length: 20 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspendedReason: varchar('suspended_reason', { length: 500 }),
  },
  (t) => ({
    bySubdomain: uniqueIndex('tenants_subdomain_unique').on(t.subdomain),
    byKindStatus: index('tenants_kind_status_idx').on(t.kind, t.status),
  }),
);

export type TenantRow = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

export const stores = pgTable(
  'stores',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    code: varchar('code', { length: 50 }).notNull(),
    type: varchar('type', { length: 50 }).notNull().default('retail'),
    isActive: boolean('is_active').notNull().default(true),
    addressLine1: varchar('address_line_1', { length: 255 }),
    addressLine2: varchar('address_line_2', { length: 255 }),
    city: varchar('city', { length: 100 }),
    state: varchar('state', { length: 100 }),
    pincode: varchar('pincode', { length: 10 }),
    country: varchar('country', { length: 2 }).notNull().default('IN'),
    latitude: decimal('latitude', { precision: 10, scale: 7 }),
    longitude: decimal('longitude', { precision: 10, scale: 7 }),
    timezone: varchar('timezone', { length: 50 }).notNull().default('Asia/Kolkata'),
    currency: varchar('currency', { length: 3 }).notNull().default('INR'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    byTenant: index('stores_tenant_idx').on(t.tenantId),
    byTenantCity: index('stores_tenant_city_idx').on(t.tenantId, t.city),
    uniqueTenantCode: uniqueIndex('stores_tenant_code_unique').on(t.tenantId, t.code),
  }),
);

export type StoreRow = typeof stores.$inferSelect;
export type NewStore = typeof stores.$inferInsert;

export const userStoreAccess = pgTable(
  'user_store_access',
  {
    ...baseColumns,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    accessLevel: userStoreAccessLevelEnum('access_level').notNull().default('read'),
    isActive: boolean('is_active').notNull().default(true),
    grantedBy: uuid('granted_by').references(() => users.id),
    grantedAt: timestamp('granted_at', { withTimezone: true }).default(sql`now()`),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id),
  },
  (t) => ({
    byUser: index('user_store_access_user_idx').on(t.userId),
    byStore: index('user_store_access_store_idx').on(t.storeId),
    uniqueUserStore: uniqueIndex('user_store_access_user_store_unique').on(t.userId, t.storeId),
  }),
);

export type UserStoreAccessRow = typeof userStoreAccess.$inferSelect;
export type NewUserStoreAccess = typeof userStoreAccess.$inferInsert;

export const tenantSettings = pgTable(
  'tenant_settings',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id')
      .notNull()
      .unique()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => ({
    byTenant: uniqueIndex('tenant_settings_tenant_unique').on(t.tenantId),
  }),
);

export type TenantSettingsRow = typeof tenantSettings.$inferSelect;
export type NewTenantSettings = typeof tenantSettings.$inferInsert;
