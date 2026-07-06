import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * BE-50 — Webhooks for Pro Tier.
 *
 * Two tables:
 *   - `webhook_endpoints`  — Pro tenants register up to 5 outbound
 *     URLs they want HMAC-signed callbacks on for the events listed
 *     in `events`. The shared `secret` is what we sign the body with.
 *   - `webhook_deliveries` — every event we attempted to fan out to
 *     a matching endpoint. Holds full payload + status + retry
 *     metadata so the BE-50 retry job can re-attempt failed posts
 *     and the replay endpoint can manually re-fire any historical
 *     delivery.
 *
 * Tenant scope sits on the endpoint; deliveries inherit tenancy via
 * the FK and a join (so we don't denormalise it). Hot path query is
 * "give me pending/failed deliveries with `next_retry_at <= now()`
 * and `attempts < 5`" — covered by `idx_webhook_deliveries_retry`.
 *
 * Per-row TTL is 7 days from creation (`expires_at`). The cleanup
 * sweep (BE-31 family) prunes old rows so failed-delivery
 * dashboards stay snappy. Live ops never reach back further than
 * 7 days for replay (Req 52).
 */

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    /**
     * HMAC-SHA256 signing secret. Stored as text in the dev schema so
     * we don't depend on KMS in tests; production rotates this through
     * the secrets manager. Matches BE-50 spec text "secret TEXT".
     */
    secret: text('secret').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /** List of event names this endpoint subscribes to. */
    events: text('events').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    /** Tenant scope index, partial on `is_active = true` so the
     *  emitter join only sees live endpoints. */
    tenantActiveIdx: index('idx_webhook_endpoints_tenant')
      .on(t.tenantId)
      .where(sql`${t.isActive} = true`),
  }),
);

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;
export type NewWebhookEndpoint = typeof webhookEndpoints.$inferInsert;

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    eventName: text('event_name').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** `'pending' | 'succeeded' | 'failed'`. */
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastStatusCode: integer('last_status_code'),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '7 days'`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    /** Retry sweeper hot path: pending/failed deliveries that haven't
     *  blown the 5-attempt cap and are due for another try. */
    retryIdx: index('idx_webhook_deliveries_retry')
      .on(t.nextRetryAt)
      .where(sql`${t.status} in ('pending', 'failed') and ${t.attempts} < 5`),
    statusCheck: check(
      'webhook_deliveries_status_chk',
      sql`${t.status} in ('pending', 'succeeded', 'failed')`,
    ),
  }),
);

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
