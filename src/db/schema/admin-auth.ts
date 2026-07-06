import { sql } from 'drizzle-orm';
import { index, pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';
import { users } from './users';

/**
 * BE-07 admin-auth tables.
 *
 * Admin login uses email/password (bcrypt cost 12 — slower than OTP
 * cost 10, intentionally). Credentials live in a separate table from
 * `users` so the OTP-only majority of the user base never has a
 * password column they don't need.
 */

export const adminCredentials = pgTable(
  'admin_credentials',
  {
    ...baseColumns,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' })
      .unique(),
    email: varchar('email', { length: 255 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    lastPasswordChangedAt: timestamp('last_password_changed_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    failedLoginAttempts: varchar('failed_login_attempts', { length: 8 }).notNull().default('0'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (t) => ({
    byEmail: uniqueIndex('admin_credentials_email_unique').on(t.email),
  }),
);

export type AdminCredentialsRow = typeof adminCredentials.$inferSelect;
export type NewAdminCredentials = typeof adminCredentials.$inferInsert;

/**
 * Single-use, hashed password-reset tokens. The token plaintext is
 * emailed to the user; we only ever store its sha256 hash so a leak
 * of `password_reset_tokens` doesn't permit reset.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    ...baseColumns,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 255 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    requestedFromIp: varchar('requested_from_ip', { length: 64 }),
  },
  (t) => ({
    byHash: uniqueIndex('password_reset_token_hash_unique').on(t.tokenHash),
    byUser: index('password_reset_tokens_user_idx').on(t.userId),
    byExpiry: index('password_reset_tokens_expires_idx').on(t.expiresAt),
  }),
);

export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;

export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    ...baseColumns,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    tokenHash: varchar('token_hash', { length: 255 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => ({
    byHash: uniqueIndex('email_verification_token_hash_unique').on(t.tokenHash),
    byUser: index('email_verification_tokens_user_idx').on(t.userId),
  }),
);

export type EmailVerificationTokenRow = typeof emailVerificationTokens.$inferSelect;
export type NewEmailVerificationToken = typeof emailVerificationTokens.$inferInsert;

/**
 * Last N password hashes per user to prevent reuse. Wiped on
 * account deletion via `ON DELETE CASCADE`.
 */
export const passwordHistory = pgTable(
  'password_history',
  {
    ...baseColumns,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  },
  (t) => ({
    byUserCreated: index('password_history_user_created_idx').on(t.userId, t.createdAt),
  }),
);

export type PasswordHistoryRow = typeof passwordHistory.$inferSelect;
export type NewPasswordHistory = typeof passwordHistory.$inferInsert;

/**
 * Admin invitation tracker. The `token_hash` mirrors the
 * password-reset pattern — plaintext goes only into the email body.
 */
export const adminInvitationStatusEnum = pgEnum('admin_invitation_status', [
  'pending',
  'accepted',
  'expired',
  'revoked',
]);

export const adminInvitations = pgTable(
  'admin_invitations',
  {
    ...baseColumns,
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    tokenHash: varchar('token_hash', { length: 255 }).notNull(),
    status: adminInvitationStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '7 days'`),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    byHash: uniqueIndex('admin_invitations_token_hash_unique').on(t.tokenHash),
    byEmailStatus: index('admin_invitations_email_status_idx').on(t.email, t.status),
  }),
);

export type AdminInvitationRow = typeof adminInvitations.$inferSelect;
export type NewAdminInvitation = typeof adminInvitations.$inferInsert;
