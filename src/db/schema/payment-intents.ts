import { sql } from 'drizzle-orm';
import {
  decimal,
  index,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-28 — Payment intent stub.
 *
 * Pre-wires the table that BE-28 v2 (Razorpay / Cashfree) will fill
 * in. v1 only needs the schema — no service calls write to it yet.
 * Keeping the migration here means BE-28 v2 won't need a fresh
 * schema migration; it just turns the writes on.
 *
 * Idempotency: every external payment provider event carries a
 * provider-side id. We persist it in `providerPaymentId` and add a
 * unique index so duplicate webhook deliveries can't double-charge.
 */
export const paymentProviderEnum = pgEnum('payment_provider', [
  'razorpay',
  'cashfree',
  'stripe',
  'manual',
]);

export const paymentIntentStatusEnum = pgEnum('payment_intent_status', [
  'pending',
  'authorized',
  'captured',
  'failed',
  'refunded',
  'cancelled',
]);

export const paymentIntents = pgTable(
  'payment_intents',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id').notNull(),
    subscriptionId: uuid('subscription_id'),

    provider: paymentProviderEnum('provider').notNull().default('manual'),
    /** Provider-side identifier (idempotency key for webhooks). */
    providerPaymentId: varchar('provider_payment_id', { length: 100 }),
    providerOrderId: varchar('provider_order_id', { length: 100 }),

    status: paymentIntentStatusEnum('status').notNull().default('pending'),

    amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('INR'),

    description: varchar('description', { length: 500 }),

    paidAt: timestamp('paid_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    failureReason: varchar('failure_reason', { length: 500 }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantIdx: index('payment_intents_tenant_idx').on(t.tenantId),
    statusIdx: index('payment_intents_status_idx').on(t.status),
    subscriptionIdx: index('payment_intents_subscription_idx').on(t.subscriptionId),
    providerPaymentUniq: uniqueIndex('payment_intents_provider_payment_unique')
      .on(t.provider, t.providerPaymentId)
      .where(sql`${t.providerPaymentId} IS NOT NULL`),
  }),
);

export type PaymentIntentRow = typeof paymentIntents.$inferSelect;
export type NewPaymentIntent = typeof paymentIntents.$inferInsert;
