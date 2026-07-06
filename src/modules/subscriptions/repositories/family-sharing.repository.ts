import { Injectable } from '@nestjs/common';
import { and, count as drizzleCount, eq, inArray } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  familySharingMembers,
  FamilySharingMemberRow,
  NewFamilySharingMember,
} from '@/db/schema/family-sharing-members';

/**
 * BE-36 — `family_sharing_members` data access.
 *
 * Handles CRUD and enforces business queries for the family sharing
 * feature. The 5-member cap is enforced at the service layer within
 * a serializable transaction using `countActiveMembers`.
 */
@Injectable()
export class FamilySharingRepository extends BaseRepository<
  typeof familySharingMembers,
  FamilySharingMemberRow,
  NewFamilySharingMember,
  Partial<NewFamilySharingMember>
> {
  constructor(db: DbService) {
    super(db.getDb(), familySharingMembers, 'family_sharing_members');
  }

  /**
   * Count active (invited + accepted) members for a primary user.
   * Used to enforce the 5-member cap atomically.
   */
  async countActiveMembers(primaryUserId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: drizzleCount() })
      .from(familySharingMembers)
      .where(
        and(
          eq(familySharingMembers.primaryUserId, primaryUserId),
          inArray(familySharingMembers.status, ['invited', 'accepted']),
        ),
      );
    return row?.value ?? 0;
  }

  /**
   * Find all active members (invited + accepted) for a primary user.
   */
  async findByPrimaryUser(primaryUserId: string): Promise<FamilySharingMemberRow[]> {
    return (await this.db
      .select()
      .from(familySharingMembers)
      .where(
        and(
          eq(familySharingMembers.primaryUserId, primaryUserId),
          inArray(familySharingMembers.status, ['invited', 'accepted']),
        ),
      )) as FamilySharingMemberRow[];
  }

  /**
   * Find a pending invite by ID and primary user.
   */
  async findInviteById(
    id: string,
    primaryUserId?: string,
  ): Promise<FamilySharingMemberRow | null> {
    const conditions = [eq(familySharingMembers.id, id)];
    if (primaryUserId) {
      conditions.push(eq(familySharingMembers.primaryUserId, primaryUserId));
    }
    const [row] = await this.db
      .select()
      .from(familySharingMembers)
      .where(and(...conditions))
      .limit(1);
    return (row as FamilySharingMemberRow | undefined) ?? null;
  }

  /**
   * Find a pending invite by mobile number for the accepting user.
   */
  async findPendingInviteByMobile(mobile: string): Promise<FamilySharingMemberRow | null> {
    const [row] = await this.db
      .select()
      .from(familySharingMembers)
      .where(
        and(
          eq(familySharingMembers.invitedMobile, mobile),
          eq(familySharingMembers.status, 'invited'),
        ),
      )
      .limit(1);
    return (row as FamilySharingMemberRow | undefined) ?? null;
  }

  /**
   * Find invite by ID for acceptance flow.
   */
  async findPendingInviteById(id: string): Promise<FamilySharingMemberRow | null> {
    const [row] = await this.db
      .select()
      .from(familySharingMembers)
      .where(
        and(eq(familySharingMembers.id, id), eq(familySharingMembers.status, 'invited')),
      )
      .limit(1);
    return (row as FamilySharingMemberRow | undefined) ?? null;
  }

  /**
   * Accept an invitation — set member_user_id, status, accepted_at.
   */
  async acceptInvite(id: string, memberUserId: string): Promise<FamilySharingMemberRow | null> {
    const [row] = await this.db
      .update(familySharingMembers)
      .set({
        memberUserId,
        status: 'accepted',
        acceptedAt: new Date(),
        updatedAt: new Date(),
      } as never)
      .where(and(eq(familySharingMembers.id, id), eq(familySharingMembers.status, 'invited')))
      .returning();
    return (row as FamilySharingMemberRow | undefined) ?? null;
  }

  /**
   * Remove a member by marking status as 'removed'.
   */
  async removeMember(id: string, primaryUserId: string): Promise<FamilySharingMemberRow | null> {
    const [row] = await this.db
      .update(familySharingMembers)
      .set({
        status: 'removed',
        removedAt: new Date(),
        updatedAt: new Date(),
      } as never)
      .where(
        and(
          eq(familySharingMembers.id, id),
          eq(familySharingMembers.primaryUserId, primaryUserId),
          inArray(familySharingMembers.status, ['invited', 'accepted']),
        ),
      )
      .returning();
    return (row as FamilySharingMemberRow | undefined) ?? null;
  }

  /**
   * Revoke all active members for a primary user (used on subscription cancel).
   */
  async revokeAllForPrimary(primaryUserId: string): Promise<number> {
    const rows = await this.db
      .update(familySharingMembers)
      .set({
        status: 'removed',
        removedAt: new Date(),
        updatedAt: new Date(),
      } as never)
      .where(
        and(
          eq(familySharingMembers.primaryUserId, primaryUserId),
          inArray(familySharingMembers.status, ['invited', 'accepted']),
        ),
      )
      .returning();
    return rows.length;
  }
}
