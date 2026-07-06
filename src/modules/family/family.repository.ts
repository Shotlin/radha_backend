import { Injectable } from '@nestjs/common';
import { and, eq, inArray, ne } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  familySharingMembers,
  FamilySharingMemberRow,
  NewFamilySharingMember,
} from '@/db/schema/family-sharing-members';
import { users } from '@/db/schema/users';

@Injectable()
export class FamilyRepository {
  constructor(private readonly db: DbService) {}

  /** Active (invited + accepted) members for a given primary user. */
  async findActiveMembers(primaryUserId: string): Promise<FamilySharingMemberRow[]> {
    return this.db
      .getDb()
      .select()
      .from(familySharingMembers)
      .where(
        and(
          eq(familySharingMembers.primaryUserId, primaryUserId),
          inArray(familySharingMembers.status, ['invited', 'accepted']),
        ),
      );
  }

  /** Count active slots used by primary user. */
  async countActiveMembers(primaryUserId: string): Promise<number> {
    const rows = await this.findActiveMembers(primaryUserId);
    return rows.length;
  }

  /** Find existing active invite for a mobile under a primary user. */
  async findExistingInvite(
    primaryUserId: string,
    mobile: string,
  ): Promise<FamilySharingMemberRow | null> {
    const [row] = await this.db
      .getDb()
      .select()
      .from(familySharingMembers)
      .where(
        and(
          eq(familySharingMembers.primaryUserId, primaryUserId),
          eq(familySharingMembers.invitedMobile, mobile),
          inArray(familySharingMembers.status, ['invited', 'accepted']),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Look up a user by mobile to get their userId for invite matching. */
  async findUserIdByMobile(mobile: string): Promise<string | null> {
    const [row] = await this.db
      .getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.mobile, mobile))
      .limit(1);
    return row?.id ?? null;
  }

  /** Insert a new family invite. */
  async createInvite(data: NewFamilySharingMember): Promise<FamilySharingMemberRow> {
    const [row] = await this.db
      .getDb()
      .insert(familySharingMembers)
      .values(data)
      .returning();
    return row;
  }

  /** Soft-remove a member (set status = 'removed'). */
  async removeMember(
    id: string,
    primaryUserId: string,
  ): Promise<boolean> {
    const result = await this.db
      .getDb()
      .update(familySharingMembers)
      .set({ status: 'removed', removedAt: new Date() })
      .where(
        and(
          eq(familySharingMembers.id, id),
          eq(familySharingMembers.primaryUserId, primaryUserId),
          ne(familySharingMembers.status, 'removed'),
        ),
      )
      .returning({ id: familySharingMembers.id });
    return result.length > 0;
  }
}
