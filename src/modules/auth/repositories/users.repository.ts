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

  async findStoreIdsByUserId(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ storeId: userStoreAccess.storeId })
      .from(userStoreAccess)
      .where(and(eq(userStoreAccess.userId, userId), eq(userStoreAccess.isActive, true)));
    return rows.map((r) => r.storeId);
  }
}
