import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { AdminInvitationRow, NewAdminInvitation, adminInvitations } from '@/db/schema/admin-auth';

@Injectable()
export class AdminInvitationsRepository extends BaseRepository<
  typeof adminInvitations,
  AdminInvitationRow,
  NewAdminInvitation,
  Partial<NewAdminInvitation>
> {
  constructor(db: DbService) {
    super(db.getDb(), adminInvitations, 'admin_invitations');
  }

  async findActiveByHash(tokenHash: string): Promise<AdminInvitationRow | null> {
    const [row] = await this.db
      .select()
      .from(adminInvitations)
      .where(and(eq(adminInvitations.tokenHash, tokenHash), eq(adminInvitations.status, 'pending')))
      .limit(1);
    return (row as AdminInvitationRow | undefined) ?? null;
  }

  async markAccepted(id: string): Promise<void> {
    await this.db
      .update(adminInvitations)
      .set({ status: 'accepted', acceptedAt: new Date() })
      .where(eq(adminInvitations.id, id));
  }

  async markRevoked(id: string): Promise<void> {
    await this.db
      .update(adminInvitations)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(adminInvitations.id, id));
  }
}
