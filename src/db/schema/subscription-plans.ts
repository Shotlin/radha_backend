import {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { baseColumns, softDeleteColumn } from './_base';

/**
 * BE-28 — Subscription plan catalog.
 *
 * Each row is a sellable plan (`trial`, `starter`, `growth`, `pro`,
 * future `enterprise`, plus the addendum-v2 `premium_consumer` and
 * `trial_pro` slots when they ship). The catalog is global — there is
 * no `tenantId` column because plans are platform-wide, not per
 * tenant. Tenant-specific overrides go in `tenant_subscriptions.metadata`.
 *
 * The default catalog (4 rows) is seeded by
 * `server/src/db/seeds/subscription-plans.seed.ts` after the BE-28
 * migration runs. The seed is idempotent — re-running it upserts
 * by `code` instead of inserting duplicates.
 */
export const subscriptionPlans = pgTable(
  'subscription_plans',
  {
    ...baseColumns,
    ...softDeleteColumn,

    code: varchar('code', { length: 30 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    description: varchar('description', { length: 1000 }),

    // Pricing — stored as decimal(10,2). Drizzle returns these as
    // strings; the service layer parses to Number when surfacing.
    price: decimal('price', { precision: 10, scale: 2 }).notNull().default('0'),
    yearlyPrice: decimal('yearly_price', { precision: 10, scale: 2 }),
    currency: varchar('currency', { length: 3 }).notNull().default('INR'),

    // Trial configuration
    trialDays: integer('trial_days').notNull().default(0),

    // Visibility
    isPublic: boolean('is_public').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    codeUniq: uniqueIndex('subscription_plans_code_unique').on(t.code),
    publicActiveIdx: index('subscription_plans_public_active_idx').on(t.isPublic, t.isActive),
  }),
);

export type SubscriptionPlanRow = typeof subscriptionPlans.$inferSelect;
export type NewSubscriptionPlan = typeof subscriptionPlans.$inferInsert;
