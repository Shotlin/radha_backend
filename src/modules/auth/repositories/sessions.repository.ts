import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewUserSession, UserSessionRow, userSessions } from '@/db/schema/users';

@Injectable()
export class SessionsRepository extends BaseRepository<
  typeof userSessions,
  UserSessionRow,
  NewUserSession,
  Partial<NewUserSession>
> {
  constructor(db: DbService) {
    super(db.getDb(), userSessions, 'user_sessions');
  }

  async findActiveById(sessionId: string): Promise<UserSessionRow | null> {
    const [row] = await this.db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.id, sessionId), eq(userSessions.isActive, true)))
      .limit(1);
    return (row as UserSessionRow | undefined) ?? null;
  }

  async revoke(
    sessionId: string,
    reason: 'logout' | 'logout_all' | 'token_theft' | 'admin' | 'expired',
  ): Promise<void> {
    await this.db
      .update(userSessions)
      .set({
        isActive: false,
        revokedAt: new Date(),
        revokedReason: reason,
      })
      .where(eq(userSessions.id, sessionId));
  }

  async revokeAllForUser(
    userId: string,
    reason: 'logout' | 'logout_all' | 'token_theft' | 'admin' | 'expired',
  ): Promise<number> {
    const rows = await this.db
      .update(userSessions)
      .set({ isActive: false, revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(userSessions.userId, userId), eq(userSessions.isActive, true)))
      .returning({ id: userSessions.id });
    return rows.length;
  }

  /**
   * `expiresAt` is pushed forward on every rotation (sliding window) rather
   * than staying pinned to the original login. Without this, a user who
   * opens the app daily would still be hard-logged-out 14 days after their
   * very first login — the opposite of "keep me signed in while I'm an
   * active user, only expire after real inactivity."
   *
   * `previousHash` records what the hash was just before this rotation —
   * see the column's own doc comment in `db/schema/users.ts` for why.
   */
  async rotateRefreshToken(
    sessionId: string,
    previousHash: string,
    newHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.db
      .update(userSessions)
      .set({
        previousRefreshTokenHash: previousHash,
        refreshTokenHash: newHash,
        lastUsedAt: new Date(),
        expiresAt,
      })
      .where(eq(userSessions.id, sessionId));
  }
}
