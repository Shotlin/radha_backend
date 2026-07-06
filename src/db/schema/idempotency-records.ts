import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * BE-44 — Idempotency record store.
 *
 * Captures the response a mutating request produced so that a retry
 * carrying the same `Idempotency-Key` header gets back the original
 * outcome instead of executing the mutation a second time. Mismatched
 * payloads on the same key are rejected as 409 Conflict.
 *
 * Records auto-expire after 24h (`expires_at` default). A scheduled
 * cleaner (BE-31 cleanup family) sweeps expired rows; the index on
 * `expires_at` keeps that scan cheap.
 *
 * Tenant scoping is enforced at the application layer via `user_id`;
 * the table is intentionally not under RLS because the middleware
 * needs to read pre-auth on rare paths (e.g. webhook replay).
 */
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    key: text('key').primaryKey(),
    userId: uuid('user_id').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '24 hours'`),
  },
  (t) => ({
    expiresIdx: index('idx_idem_expires').on(t.expiresAt),
  }),
);

export type IdempotencyRecordRow = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecord = typeof idempotencyRecords.$inferInsert;
