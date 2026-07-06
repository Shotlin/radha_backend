import { Injectable } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewOtpAttempt, OtpAttemptRow, otpAttempts } from '@/db/schema/users';

@Injectable()
export class OtpAttemptsRepository extends BaseRepository<
  typeof otpAttempts,
  OtpAttemptRow,
  NewOtpAttempt,
  Partial<NewOtpAttempt>
> {
  constructor(db: DbService) {
    super(db.getDb(), otpAttempts, 'otp_attempts');
  }

  async findByRequestId(requestId: string): Promise<OtpAttemptRow | null> {
    const [row] = await this.db
      .select()
      .from(otpAttempts)
      .where(eq(otpAttempts.requestId, requestId))
      .limit(1);
    return (row as OtpAttemptRow | undefined) ?? null;
  }

  /**
   * Atomic `attempt_count = attempt_count + 1`. Uses a raw SQL
   * fragment because Drizzle's `set()` does not yet expose a
   * column-self-reference helper for arithmetic.
   */
  async incrementAttempt(id: string): Promise<void> {
    await this.db
      .update(otpAttempts)
      .set({ attemptCount: sql`${otpAttempts.attemptCount} + 1` })
      .where(eq(otpAttempts.id, id));
  }

  async markVerified(id: string): Promise<void> {
    await this.db
      .update(otpAttempts)
      .set({ isVerified: true, verifiedAt: new Date() })
      .where(eq(otpAttempts.id, id));
  }

  async markExpired(id: string): Promise<void> {
    await this.db.update(otpAttempts).set({ isExpired: true }).where(eq(otpAttempts.id, id));
  }

  async countActiveSince(mobile: string, since: Date): Promise<number> {
    const rows = await this.db
      .select({ id: otpAttempts.id })
      .from(otpAttempts)
      .where(and(eq(otpAttempts.mobile, mobile), gte(otpAttempts.createdAt, since)));
    return rows.length;
  }
}
