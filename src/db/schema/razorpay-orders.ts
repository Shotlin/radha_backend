import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-28 v2 — Razorpay order ledger.
 *
 * One row per Razorpay order created via `POST /api/v1/payments/checkout`.
 * The row tracks the lifecycle of the payment from creation through
 * verification, capture, and (optionally) refund. The status column
 * is a free `text` (not a pgEnum) because the existing
 * `payment_intent_status` enum is reserved for the legacy
 * `payment_intents` ledger and we don't want a schema-coupling
 * between the two pipelines — Razorpay's vocabulary
 * (`created → authorised → captured → refunded → failed`) is the
 * source of truth here.
 *
 * Multi-tenant scoping:
 *   - `tenantId` is nullable for consumer-tier payments (the user's
 *     personal tenant isn't bootstrapped until BE-09 v2 / BE-35).
 *   - `userId` is mandatory and is what the repository keys lookups on.
 *   - Composite index leads with `tenantId` per the architecture
 *     funnel rules; a second `(userId, status)` index covers the
 *     hot path for "show me my pending checkout".
 *
 * Idempotency:
 *   - `razorpayOrderId` is unique. Webhook retries that fire on the
 *     same order id flip status forward without creating duplicates.
 */
export const razorpayOrders = pgTable(
  'razorpay_orders',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id'),
    userId: uuid('user_id').notNull(),
    planId: uuid('plan_id').notNull(),

    razorpayOrderId: text('razorpay_order_id').notNull(),
    /** `created | authorised | captured | refunded | failed`. */
    status: text('status').notNull().default('created'),

    amountPaise: integer('amount_paise').notNull(),
    currency: text('currency').notNull().default('INR'),

    /** Free-form metadata kept on the order (planCode, billingCycle, …). */
    notes: jsonb('notes').$type<Record<string, unknown>>(),

    /** Razorpay payment id captured at verify-time. */
    razorpayPaymentId: text('razorpay_payment_id'),

    /** When `payment.captured` (or successful verify) lands. */
    postedAt: timestamp('posted_at', { withTimezone: true }),
    /** When `refund.processed` lands. */
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    /** When `payment.failed` lands. */
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (t) => ({
    razorpayOrderUniq: uniqueIndex('razorpay_orders_order_id_unique').on(t.razorpayOrderId),
    tenantStatusIdx: index('razorpay_orders_tenant_status_idx').on(t.tenantId, t.status),
    userStatusIdx: index('razorpay_orders_user_status_idx').on(t.userId, t.status),
    planIdx: index('razorpay_orders_plan_idx').on(t.planId),
    createdIdx: index('razorpay_orders_created_at_idx').on(t.createdAt),
  }),
);

export type RazorpayOrderRow = typeof razorpayOrders.$inferSelect;
export type NewRazorpayOrder = typeof razorpayOrders.$inferInsert;

export type RazorpayOrderStatus = 'created' | 'authorised' | 'captured' | 'refunded' | 'failed';
