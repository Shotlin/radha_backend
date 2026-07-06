import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  NewPasswordResetToken,
  PasswordResetTokenRow,
  passwordResetTokens,
} from '@/db/schema/admin-auth';

@Injectable()
export class PasswordResetRepository extends BaseRepository<
  typeof passwordResetTokens,
  PasswordResetTokenRow,
  NewPasswordResetToken,
  Partial<NewPasswordResetToken>
> {
  constructor(db: DbService) {
    super(db.getDb(), passwordResetTokens, 'password_reset_tokens');
  }

  async findActiveByHash(tokenHash: string): Promise<PasswordResetTokenRow | null> {
    const [row] = await this.db
      .select()
      .from(passwordResetTokens)
      .where(
        and(eq(passwordResetTokens.tokenHash, tokenHash), isNull(passwordResetTokens.consumedAt)),
      )
      .limit(1);
    return (row as PasswordResetTokenRow | undefined) ?? null;
  }

  async markConsumed(id: string): Promise<void> {
    await this.db
      .update(passwordResetTokens)
      .set({ consumedAt: new Date() })
      .where(eq(passwordResetTokens.id, id));
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const rows = await this.db
      .update(passwordResetTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.consumedAt)))
      .returning({ id: passwordResetTokens.id });
    return rows.length;
  }
}
