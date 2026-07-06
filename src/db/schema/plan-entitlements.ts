import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';
import { subscriptionPlans } from './subscription-plans';

/**
 * BE-28 — Per-plan feature entitlements.
 *
 * One row per (plan, feature) pair. The `feature` column is a free
 * varchar (rather than a pgEnum) because adding new features should
 * be a deploy of the plan seed file — not a schema migration. The
 * service layer enforces the canonical `Feature` union via
 * `subscription.types.ts`.
 *
 * `isUnlimited = true` ⇒ the limit is uncapped (Pro plan stores /
 * users / scans). `limitValue` is then ignored by the entitlement
 * service. When `isUnlimited = false`, `limitValue` is the integer
 * cap; `null` means "feature not enabled" (zero quota).
 *
 * Entitlement rows are eager-loaded once per plan and cached in the
 * service; the unique index guarantees we never end up with two
 * conflicting rules for the same (plan, feature) pair.
 */
export const planEntitlements = pgTable(
  'plan_entitlements',
  {
    ...baseColumns,
    planId: uuid('plan_id')
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: 'cascade' }),
    feature: varchar('feature', { length: 50 }).notNull(),
    limitValue: integer('limit_value'),
    isUnlimited: boolean('is_unlimited').notNull().default(false),
    description: varchar('description', { length: 500 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    planIdx: index('plan_entitlements_plan_idx').on(t.planId),
    featureIdx: index('plan_entitlements_feature_idx').on(t.feature),
    planFeatureUniq: uniqueIndex('plan_entitlements_plan_feature_unique').on(t.planId, t.feature),
  }),
);

export type PlanEntitlementRow = typeof planEntitlements.$inferSelect;
export type NewPlanEntitlement = typeof planEntitlements.$inferInsert;
