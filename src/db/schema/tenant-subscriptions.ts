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

import { auditColumns, baseColumns } from './_base';

/**
 * BE-28 — Active subscription per tenant.
 *
 * Exactly one row per tenant — enforced by `tenant_subscriptions_tenant_unique`.
 * When a tenant upgrades / downgrades / cancels, the same row is
 * mutated and the lifecycle event is appended to `subscription_events`.
 *
 * Status machine:
 *   pending_setup → trial → active ⇄ past_due → cancelled / expired
 *                       ↘ paused (manual override) ↗
 *
 * Cancellation is soft — `cancelledAt` is stamped immediately but
 * `status` stays `active` until `currentPeriodEnd` is reached, at
 * which point the renewal cron flips it to `expired`. This is the
 * "graceful cancellation" the spec calls for in Test 11.
 */
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'trial',
  'active',
  'expired',
  'cancelled',
  'past_due',
  'paused',
]);

export const tenantSubscriptions = pgTable(
  'tenant_subscriptions',
  {
    ...baseColumns,
    ...auditColumns,

    tenantId: uuid('tenant_id').notNull(),
    planId: uuid('plan_id').notNull(),
    /**
     * Denormalised plan code — saves a join on every entitlement
     * read and lets us answer "what plan is tenant X on?" with a
     * single index hit.
     */
    planCode: varchar('plan_code', { length: 30 }).notNull(),

    status: subscriptionStatusEnum('status').notNull().default('trial'),

    // Trial window (only set while status='trial' or after upgrade)
    trialStartedAt: timestamp('trial_started_at', { withTimezone: true }),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),

    // Billing period for the current cycle
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),

    // Cancellation
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: varchar('cancellation_reason', { length: 500 }),

    // Billing
    monthlyAmount: decimal('monthly_amount', { precision: 10, scale: 2 }).notNull().default('0'),
    nextBillingDate: timestamp('next_billing_date', { withTimezone: true }),
    paymentMethod: varchar('payment_method', { length: 50 }),

    // Tracking
    lastPaymentAt: timestamp('last_payment_at', { withTimezone: true }),
    failedPaymentAttempts: integer('failed_payment_attempts').notNull().default(0),

    /**
     * Scheduled downgrade — when the user picks a smaller plan
     * mid-cycle, we stash the target plan id here and let the
     * renewal cron apply it at `currentPeriodEnd`. Spec test 8
     * ("downgrade scheduled for end of billing cycle").
     */
    pendingPlanId: uuid('pending_plan_id'),
    pendingPlanCode: varchar('pending_plan_code', { length: 30 }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantUniq: uniqueIndex('tenant_subscriptions_tenant_unique').on(t.tenantId),
    statusIdx: index('tenant_subscriptions_status_idx').on(t.status),
    trialEndsIdx: index('tenant_subscriptions_trial_ends_idx').on(t.trialEndsAt),
    nextBillingIdx: index('tenant_subscriptions_next_billing_idx').on(t.nextBillingDate),
    planCodeIdx: index('tenant_subscriptions_plan_code_idx').on(t.planCode),
  }),
);

export type TenantSubscriptionRow = typeof tenantSubscriptions.$inferSelect;
export type NewTenantSubscription = typeof tenantSubscriptions.$inferInsert;
