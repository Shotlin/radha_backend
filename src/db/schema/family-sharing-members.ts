import { index, pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-36 — Family Sharing members table.
 *
 * Links a primary Premium Consumer subscriber to up to 5 family
 * members. Derived entitlements are granted to each accepted member.
 *
 * The DB-level unique constraint on (primary_user_id) with a check
 * count ≤ 5 is enforced application-side via a serializable
 * transaction + count guard before insert.
 */
export const familySharingStatusEnum = pgEnum('family_sharing_status', [
  'invited',
  'accepted',
  'removed',
  'expired',
]);

export const familySharingMembers = pgTable(
  'family_sharing_members',
  {
    ...baseColumns,

    /** The user who owns the Premium Consumer subscription. */
    primaryUserId: uuid('primary_user_id').notNull(),

    /** The user who is being invited / has joined the family group. */
    memberUserId: uuid('member_user_id'),

    /** Mobile number used for the invite (before account match). */
    invitedMobile: varchar('invited_mobile', { length: 15 }).notNull(),

    status: familySharingStatusEnum('status').notNull().default('invited'),

    /** When the invitation was accepted. */
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),

    /** When the member was removed or left. */
    removedAt: timestamp('removed_at', { withTimezone: true }),

    /** Expiry of the invite link (48 hours from creation). */
    inviteExpiresAt: timestamp('invite_expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    primaryUserIdx: index('family_sharing_primary_user_idx').on(t.primaryUserId),
    memberUserIdx: index('family_sharing_member_user_idx').on(t.memberUserId),
    statusIdx: index('family_sharing_status_idx').on(t.status),
    /** Prevent duplicate active invites for the same mobile under a primary user. */
    uniqueActiveInvite: uniqueIndex('family_sharing_unique_active_invite').on(
      t.primaryUserId,
      t.invitedMobile,
      t.status,
    ),
  }),
);

export type FamilySharingMemberRow = typeof familySharingMembers.$inferSelect;
export type NewFamilySharingMember = typeof familySharingMembers.$inferInsert;
