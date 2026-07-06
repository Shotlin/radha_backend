import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { users } from './users';

/**
 * BE-53 — Admin Impersonation Tool.
 *
 * Two tables:
 *   - `impersonation_sessions` records every "view as user" session a
 *     RADHA support staff member opens on behalf of a tenant user.
 *     Sessions cap at 60 minutes. `ended_at` stays null while the
 *     session is live; the JWT minted for the session carries
 *     `sessionId` so the service can look up + revoke on logout or
 *     expiry. A reason >= 10 chars is mandatory.
 *   - `impersonation_actions` is the per-request audit ledger written
 *     by `ImpersonationActionLoggerMiddleware`. Every HTTP method,
 *     path, and final response status during an active session lands
 *     here so we can replay exactly what staff touched on a tenant's
 *     account.
 *
 * The actions table is intentionally narrow (no payload capture): it
 * survives DPA review because it never holds user content, only the
 * route metadata. PII goes nowhere near these rows.
 */

export const impersonationSessions = pgTable(
  'impersonation_sessions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** RADHA support staff who opened the session. Must have role `admin`. */
    staffUserId: uuid('staff_user_id')
      .notNull()
      .references(() => users.id),
    /** Tenant user being impersonated. */
    impersonatedUserId: uuid('impersonated_user_id')
      .notNull()
      .references(() => users.id),
    /**
     * Free-text justification supplied by the staff member. Surfaces
     * in the impersonated user's audit log download (Req 51) and any
     * compliance review. Min length enforced by the SQL CHECK.
     */
    reason: text('reason').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Hard 60-minute cap; the JWT exp matches this column. */
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '60 minutes'`),
    /** Null while session is live; set when staff ends or the cron sweep expires it. */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** `'manual_end' | 'expired' | 'admin_revoked'` — free text for forward compatibility. */
    endedReason: text('ended_reason'),
  },
  (t) => ({
    /** Hot-path lookup: any active sessions for a given staff user. */
    activeByStaffIdx: index('idx_impersonation_sessions_staff_active')
      .on(t.staffUserId)
      .where(sql`${t.endedAt} is null`),
    reasonMin: check('impersonation_reason_min', sql`length(${t.reason}) >= 10`),
  }),
);

export type ImpersonationSessionRow = typeof impersonationSessions.$inferSelect;
export type NewImpersonationSession = typeof impersonationSessions.$inferInsert;

export const impersonationActions = pgTable(
  'impersonation_actions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => impersonationSessions.id, { onDelete: 'cascade' }),
    requestPath: text('request_path').notNull(),
    requestMethod: text('request_method').notNull(),
    responseStatus: integer('response_status').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    /** Per-session timeline lookup for the audit endpoint. */
    bySessionTime: index('idx_impersonation_actions_session').on(t.sessionId, t.occurredAt),
  }),
);

export type ImpersonationActionRow = typeof impersonationActions.$inferSelect;
export type NewImpersonationAction = typeof impersonationActions.$inferInsert;
