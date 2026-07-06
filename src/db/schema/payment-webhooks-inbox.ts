import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * BE-28 v2 — Webhook idempotency anchor.
 *
 * Every inbound payment-provider webhook (currently only
 * `razorpay`, but `cashfree`/`stripe` slot in here too) is recorded
 * exactly once, keyed on the provider's `event_id`. The unique
 * constraint on `event_id` is what makes the webhook handler
 * idempotent: a duplicate delivery from Razorpay collides on insert
 * and short-circuits with a 200 OK so the provider stops retrying.
 *
 * Two timestamps drive the lifecycle:
 *   - `receivedAt`  — defaulted to `now()` at insert time.
 *   - `processedAt` — stamped after the handler successfully
 *                     applies side-effects (status flip, audit log,
 *                     subscription transition). A null `processedAt`
 *                     paired with a non-null `processingError` means
 *                     the handler crashed mid-way and the cron
 *                     replay job (or manual re-run) should pick it
 *                     up next.
 *
 * The `(provider, event_type, received_at desc)` composite index is
 * the canonical query for the BE-31 owner dashboard's "latest
 * payment events" widget.
 */
export const paymentWebhooksInbox = pgTable(
  'payment_webhooks_inbox',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    signature: text('signature').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processingError: text('processing_error'),
  },
  (t) => ({
    eventIdUniq: uniqueIndex('payment_webhooks_inbox_event_id_unique').on(t.eventId),
    providerTypeReceivedIdx: index('payment_webhooks_inbox_provider_type_received_idx').on(
      t.provider,
      t.eventType,
      t.receivedAt,
    ),
    receivedIdx: index('payment_webhooks_inbox_received_idx').on(t.receivedAt),
  }),
);

export type PaymentWebhookInboxRow = typeof paymentWebhooksInbox.$inferSelect;
export type NewPaymentWebhookInbox = typeof paymentWebhooksInbox.$inferInsert;
