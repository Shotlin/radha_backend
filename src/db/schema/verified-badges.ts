import { sql } from 'drizzle-orm';
import { decimal, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * BE-52 — RADHA Verified Badge.
 *
 * One row per tenant (`UNIQUE(tenant_id)`). The cron job either
 * issues a fresh row (status `'issued'`) when a Pro tenant has held
 * OHS >= 75 for 30 consecutive days, or flips an existing issued
 * row to `'revoked'` (with `revoked_reason`) when OHS drops below
 * 70 for 7 consecutive days.
 *
 * `last_score` tracks the most recent OHS total observed at the
 * time of (re)issue so the verify endpoint can show the score
 * the tenant earned the badge with.
 *
 * Re-issuance is supported: when a previously revoked tenant
 * becomes eligible again the existing row is updated back to
 * `'issued'` (the unique tenant_id constraint guarantees one
 * row per tenant — see `VerifiedBadgeRepository.upsertIssue`).
 */
export const verifiedBadges = pgTable(
  'radha_verified_badges',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .unique()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    lastScore: decimal('last_score', { precision: 5, scale: 2 }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    byTenant: uniqueIndex('radha_verified_badges_tenant_unique').on(t.tenantId),
    byStatus: index('radha_verified_badges_status_idx').on(t.status),
  }),
);

export type VerifiedBadgeRow = typeof verifiedBadges.$inferSelect;
export type NewVerifiedBadge = typeof verifiedBadges.$inferInsert;

export type VerifiedBadgeStatus = 'issued' | 'revoked';
