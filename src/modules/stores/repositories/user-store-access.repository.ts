import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewUserStoreAccess, UserStoreAccessRow, userStoreAccess } from '@/db/schema/tenants';

@Injectable()
export class UserStoreAccessRepository extends BaseRepository<
  typeof userStoreAccess,
  UserStoreAccessRow,
  NewUserStoreAccess,
  Partial<NewUserStoreAccess>
> {
  constructor(db: DbService) {
    super(db.getDb(), userStoreAccess, 'user_store_access');
  }

  async listActiveStoresForUser(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ storeId: userStoreAccess.storeId })
      .from(userStoreAccess)
      .where(and(eq(userStoreAccess.userId, userId), eq(userStoreAccess.isActive, true)));
    return rows.map((r) => r.storeId);
  }

  async listActiveUsersForStore(storeId: string): Promise<UserStoreAccessRow[]> {
    return (await this.db
      .select()
      .from(userStoreAccess)
      .where(
        and(eq(userStoreAccess.storeId, storeId), eq(userStoreAccess.isActive, true)),
      )) as UserStoreAccessRow[];
  }

  async findActive(userId: string, storeId: string): Promise<UserStoreAccessRow | null> {
    const [row] = await this.db
      .select()
      .from(userStoreAccess)
      .where(
        and(
          eq(userStoreAccess.userId, userId),
          eq(userStoreAccess.storeId, storeId),
          eq(userStoreAccess.isActive, true),
        ),
      )
      .limit(1);
    return (row as UserStoreAccessRow | undefined) ?? null;
  }

  async revoke(userId: string, storeId: string, revokedBy: string): Promise<void> {
    await this.db
      .update(userStoreAccess)
      .set({ isActive: false, revokedAt: new Date(), revokedBy })
      .where(and(eq(userStoreAccess.userId, userId), eq(userStoreAccess.storeId, storeId)));
  }
}
