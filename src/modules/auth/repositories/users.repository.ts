import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewUser, UserRow, users } from '@/db/schema/users';
import { userStoreAccess } from '@/db/schema/tenants';

@Injectable()
export class UsersRepository extends BaseRepository<
  typeof users,
  UserRow,
  NewUser,
  Partial<NewUser>
> {
  constructor(db: DbService) {
    super(db.getDb(), users, 'users');
  }

  async findByMobile(mobile: string): Promise<UserRow | null> {
    const [row] = await this.db.select().from(users).where(eq(users.mobile, mobile)).limit(1);
    return (row as UserRow | undefined) ?? null;
  }

  /** Phase 13 — resolves a user already linked to a Firebase identity. */
  async findByFirebaseUid(firebaseUid: string): Promise<UserRow | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.firebaseUid, firebaseUid))
      .limit(1);
    return (row as UserRow | undefined) ?? null;
  }

  /**
   * Phase 13 — used only to auto-link a pre-existing OTP-era user whose
   * `email` happens to match a Google sign-in's verified email. Not a
   * general-purpose lookup: `email` is not unique-constrained (unlike
   * `mobile`), so callers must not assume at most one row can ever match
   * in a way that matters for correctness beyond "take the first".
   */
  async findByEmail(email: string): Promise<UserRow | null> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return (row as UserRow | undefined) ?? null;
  }

  async findStoreIdsByUserId(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ storeId: userStoreAccess.storeId })
      .from(userStoreAccess)
      .where(and(eq(userStoreAccess.userId, userId), eq(userStoreAccess.isActive, true)));
    return rows.map((r) => r.storeId);
  }
}
