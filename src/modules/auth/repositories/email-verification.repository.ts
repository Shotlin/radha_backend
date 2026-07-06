import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  EmailVerificationTokenRow,
  NewEmailVerificationToken,
  emailVerificationTokens,
} from '@/db/schema/admin-auth';

@Injectable()
export class EmailVerificationRepository extends BaseRepository<
  typeof emailVerificationTokens,
  EmailVerificationTokenRow,
  NewEmailVerificationToken,
  Partial<NewEmailVerificationToken>
> {
  constructor(db: DbService) {
    super(db.getDb(), emailVerificationTokens, 'email_verification_tokens');
  }

  async findActiveByHash(tokenHash: string): Promise<EmailVerificationTokenRow | null> {
    const [row] = await this.db
      .select()
      .from(emailVerificationTokens)
      .where(
        and(
          eq(emailVerificationTokens.tokenHash, tokenHash),
          isNull(emailVerificationTokens.consumedAt),
        ),
      )
      .limit(1);
    return (row as EmailVerificationTokenRow | undefined) ?? null;
  }

  async markConsumed(id: string): Promise<void> {
    await this.db
      .update(emailVerificationTokens)
      .set({ consumedAt: new Date() })
      .where(eq(emailVerificationTokens.id, id));
  }
}
