import { Injectable } from '@nestjs/common';
import { and, eq, gt } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewPendingInvitation, PendingInvitationRow, pendingInvitations } from '@/db/schema/users';

@Injectable()
export class PendingInvitationsRepository extends BaseRepository<
  typeof pendingInvitations,
  PendingInvitationRow,
  NewPendingInvitation,
  Partial<NewPendingInvitation>
> {
  constructor(db: DbService) {
    super(db.getDb(), pendingInvitations, 'pending_invitations');
  }

  async findActiveByMobile(mobile: string): Promise<PendingInvitationRow | null> {
    const now = new Date();
    const [row] = await this.db
      .select()
      .from(pendingInvitations)
      .where(
        and(
          eq(pendingInvitations.inviteeMobile, mobile),
          eq(pendingInvitations.status, 'pending'),
          gt(pendingInvitations.expiresAt, now),
        ),
      )
      .limit(1);
    return (row as PendingInvitationRow | undefined) ?? null;
  }

  async markAccepted(id: string): Promise<void> {
    await this.db
      .update(pendingInvitations)
      .set({ status: 'accepted', acceptedAt: new Date() })
      .where(eq(pendingInvitations.id, id));
  }

  async markExpired(id: string): Promise<void> {
    await this.db
      .update(pendingInvitations)
      .set({ status: 'expired' })
      .where(eq(pendingInvitations.id, id));
  }
}
