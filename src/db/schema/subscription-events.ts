import { decimal, index, jsonb, pgEnum, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-28 — Append-only subscription audit trail.
 *
 * Every state transition on `tenant_subscriptions` (and every
 * payment-related lifecycle hit) gets a row here. Mirrors the
 * `grn_events` pattern from BE-26 — strictly insert-only, never
 * updated, never deleted (except via tenant teardown cascade).
 */
export const subscriptionEventTypeEnum = pgEnum('subscription_event_type', [
  'trial_started',
  'trial_extended',
  'trial_expiring_soon',
  'trial_expired',
  'plan_upgraded',
  'plan_downgraded',
  'plan_downgrade_scheduled',
  'subscription_renewed',
  'subscription_cancelled',
  'subscription_reactivated',
  'subscription_paused',
  'subscription_resumed',
  'payment_succeeded',
  'payment_failed',
]);

export const subscriptionEvents = pgTable(
  'subscription_events',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id').notNull(),
    subscriptionId: uuid('subscription_id'),

    type: subscriptionEventTypeEnum('type').notNull(),

    oldPlanCode: varchar('old_plan_code', { length: 30 }),
    newPlanCode: varchar('new_plan_code', { length: 30 }),

    amount: decimal('amount', { precision: 10, scale: 2 }),
    actorId: uuid('actor_id'),
    notes: varchar('notes', { length: 1000 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantCreatedIdx: index('subscription_events_tenant_created_idx').on(t.tenantId, t.createdAt),
    typeIdx: index('subscription_events_type_idx').on(t.type),
    subscriptionIdx: index('subscription_events_subscription_idx').on(t.subscriptionId),
  }),
);

export type SubscriptionEventRow = typeof subscriptionEvents.$inferSelect;
export type NewSubscriptionEvent = typeof subscriptionEvents.$inferInsert;
