import { Injectable } from '@nestjs/common';
import { and, eq, or } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { familySharingMembers } from '@/db/schema/family-sharing-members';

/**
 * BE-38 — Lookup repository for family sharing relationships.
 *
 * Used by ExpiryCalendarService to discover accepted family members
 * whose saved products should appear in the Premium user's calendar.
 */
@Injectable()
export class FamilySharingRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Get all accepted family member user IDs for a given user.
   * A user can be either the primary (owner) or a member in a family group.
   */
  async getAcceptedFamilyUserIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .getDb()
      .select({
        primaryUserId: familySharingMembers.primaryUserId,
        memberUserId: familySharingMembers.memberUserId,
      })
      .from(familySharingMembers)
      .where(
        and(
          eq(familySharingMembers.status, 'accepted'),
          or(
            eq(familySharingMembers.primaryUserId, userId),
            eq(familySharingMembers.memberUserId, userId),
          ),
        ),
      );

    const userIds = new Set<string>();

    for (const row of rows) {
      if (row.primaryUserId && row.primaryUserId !== userId) {
        userIds.add(row.primaryUserId);
      }
      if (row.memberUserId && row.memberUserId !== userId) {
        userIds.add(row.memberUserId);
      }
    }

    return Array.from(userIds);
  }
}
