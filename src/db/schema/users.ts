import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { auditColumns, baseColumns, softDeleteColumn } from './_base';

/**
 * Six canonical user roles per Req 1.5 + BE-08 v2 ADDENDUM:
 *   - owner / manager / staff / auditor → business roles
 *   - consumer                          → default for new mobile signups (Req 1.6)
 *   - admin                             → RADHA platform admins (BE-07, email/password)
 */
export const userRoleEnum = pgEnum('user_role', [
  'owner',
  'manager',
  'staff',
  'auditor',
  'consumer',
  'admin',
]);

export const subscriptionTierEnum = pgEnum('subscription_tier', [
  'free_consumer',
  'premium_consumer',
  'trial_pro',
  'starter',
  'growth',
  'pro',
]);

/**
 * Users table — primary identity row.
 *
 * `tenant_id` is nullable: a brand-new Consumer signup is provisioned
 * a personal tenant later in BE-09 v2; until that lands, we record the
 * user without a tenant scope and patch it during the BE-35 business
 * activation flow.
 */
export const users = pgTable(
  'users',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    tenantId: uuid('tenant_id'),
    mobile: varchar('mobile', { length: 20 }).notNull(),
    email: varchar('email', { length: 255 }),
    name: varchar('name', { length: 100 }).notNull().default(''),
    role: userRoleEnum('role').notNull().default('consumer'),
    subscriptionTier: subscriptionTierEnum('subscription_tier').notNull().default('free_consumer'),
    onboardingSegment: varchar('onboarding_segment', { length: 32 }),
    onboardingSegmentSelectedAt: timestamp('onboarding_segment_selected_at', {
      withTimezone: true,
    }),
    preferredLanguage: varchar('preferred_language', { length: 8 }).notNull().default('en'),
    isVerified: boolean('is_verified').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /**
     * BE-43 — 8-char uppercase alphanumeric referral code, unique per user.
     * Nullable so historical rows / non-consumer accounts can opt out;
     * the referrals service backfills lazily on first GET /referrals/me.
     */
    referralCode: text('referral_code'),
    /**
     * BE-43 — User who invited this user (set once on signup-apply).
     * Nullable; self-references must be rejected at the service layer.
     */
    referredByUserId: uuid('referred_by_user_id'),
  },
  (t) => ({
    uniqueMobile: uniqueIndex('users_mobile_unique').on(t.mobile),
    byTenantRole: index('users_tenant_role_idx').on(t.tenantId, t.role),
    byEmail: index('users_email_idx').on(t.email),
    uniqueReferralCode: uniqueIndex('users_referral_code_unique').on(t.referralCode),
    byReferredBy: index('users_referred_by_idx').on(t.referredByUserId),
  }),
);

export type UserRow = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/* === user_sessions ====================================================== */

export const sessionRevokeReasonEnum = pgEnum('session_revoke_reason', [
  'logout',
  'logout_all',
  'token_theft',
  'admin',
  'expired',
]);

export const sessionPlatformEnum = pgEnum('session_platform', ['mobile', 'web', 'admin']);

export const userSessions = pgTable(
  'user_sessions',
  {
    ...baseColumns,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: varchar('refresh_token_hash', { length: 255 }).notNull(),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: varchar('user_agent', { length: 500 }),
    deviceId: varchar('device_id', { length: 255 }),
    platform: sessionPlatformEnum('platform').notNull().default('mobile'),
    isActive: boolean('is_active').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).default(sql`now()`),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: sessionRevokeReasonEnum('revoked_reason'),
  },
  (t) => ({
    byUserActive: index('sessions_user_active_idx').on(t.userId, t.isActive),
    byHash: index('sessions_refresh_hash_idx').on(t.refreshTokenHash),
    byExpiry: index('sessions_expires_idx').on(t.expiresAt),
  }),
);

export type UserSessionRow = typeof userSessions.$inferSelect;
export type NewUserSession = typeof userSessions.$inferInsert;

/* === otp_attempts ======================================================= */

export const otpAttempts = pgTable(
  'otp_attempts',
  {
    ...baseColumns,
    requestId: uuid('request_id').notNull().unique(),
    mobile: varchar('mobile', { length: 20 }).notNull(),
    otpHash: varchar('otp_hash', { length: 255 }).notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    isVerified: boolean('is_verified').notNull().default(false),
    isExpired: boolean('is_expired').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    ipAddress: varchar('ip_address', { length: 64 }),
  },
  (t) => ({
    byMobileTime: index('otp_mobile_created_idx').on(t.mobile, t.createdAt),
    byRequest: index('otp_request_id_idx').on(t.requestId),
    byExpiry: index('otp_expires_idx').on(t.expiresAt),
  }),
);

export type OtpAttemptRow = typeof otpAttempts.$inferSelect;
export type NewOtpAttempt = typeof otpAttempts.$inferInsert;

/* === pending_invitations (BE-06 v2 ADDENDUM, Req 55) ==================== */

export const invitationStatusEnum = pgEnum('invitation_status', [
  'pending',
  'accepted',
  'expired',
  'revoked',
]);

export const invitedRoleEnum = pgEnum('invited_role', ['staff', 'manager', 'auditor']);

export const pendingInvitations = pgTable(
  'pending_invitations',
  {
    ...baseColumns,
    inviterUserId: uuid('inviter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    inviterTenantId: uuid('inviter_tenant_id').notNull(),
    inviteeMobile: varchar('invitee_mobile', { length: 20 }).notNull(),
    assignedRole: invitedRoleEnum('assigned_role').notNull(),
    storeId: uuid('store_id'),
    status: invitationStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '30 days'`),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    byMobilePending: index('invitations_mobile_pending_idx').on(t.inviteeMobile, t.status),
    byInviter: index('invitations_inviter_idx').on(t.inviterUserId),
  }),
);

export type PendingInvitationRow = typeof pendingInvitations.$inferSelect;
export type NewPendingInvitation = typeof pendingInvitations.$inferInsert;
