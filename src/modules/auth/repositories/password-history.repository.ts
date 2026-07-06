import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewPasswordHistory, PasswordHistoryRow, passwordHistory } from '@/db/schema/admin-auth';

@Injectable()
export class PasswordHistoryRepository extends BaseRepository<
  typeof passwordHistory,
  PasswordHistoryRow,
  NewPasswordHistory,
  Partial<NewPasswordHistory>
> {
  constructor(db: DbService) {
    super(db.getDb(), passwordHistory, 'password_history');
  }

  async findRecentForUser(userId: string, limit: number): Promise<PasswordHistoryRow[]> {
    const rows = await this.db
      .select()
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, userId))
      .orderBy(desc(passwordHistory.createdAt))
      .limit(limit);
    return rows as PasswordHistoryRow[];
  }

  async deleteOlderThanRank(userId: string, keep: number): Promise<void> {
    const recent = await this.db
      .select({ id: passwordHistory.id })
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, userId))
      .orderBy(desc(passwordHistory.createdAt))
      .limit(keep);
    const keepIds = new Set(recent.map((r) => r.id));
    const all = await this.db
      .select({ id: passwordHistory.id })
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, userId));
    const toDelete = all.map((r) => r.id).filter((id) => !keepIds.has(id));
    if (toDelete.length === 0) return;
    for (const id of toDelete) await this.hardDelete(id);
  }
}
