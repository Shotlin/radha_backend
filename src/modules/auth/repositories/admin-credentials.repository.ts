import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { AdminCredentialsRow, NewAdminCredentials, adminCredentials } from '@/db/schema/admin-auth';

@Injectable()
export class AdminCredentialsRepository extends BaseRepository<
  typeof adminCredentials,
  AdminCredentialsRow,
  NewAdminCredentials,
  Partial<NewAdminCredentials>
> {
  constructor(db: DbService) {
    super(db.getDb(), adminCredentials, 'admin_credentials');
  }

  async findByEmail(email: string): Promise<AdminCredentialsRow | null> {
    const [row] = await this.db
      .select()
      .from(adminCredentials)
      .where(eq(adminCredentials.email, email.toLowerCase()))
      .limit(1);
    return (row as AdminCredentialsRow | undefined) ?? null;
  }

  async findByUserId(userId: string): Promise<AdminCredentialsRow | null> {
    const [row] = await this.db
      .select()
      .from(adminCredentials)
      .where(eq(adminCredentials.userId, userId))
      .limit(1);
    return (row as AdminCredentialsRow | undefined) ?? null;
  }

  async incrementFailedAttempts(id: string): Promise<number> {
    const [row] = await this.db
      .update(adminCredentials)
      .set({
        failedLoginAttempts: sql`(${adminCredentials.failedLoginAttempts}::int + 1)::text`,
      })
      .where(eq(adminCredentials.id, id))
      .returning({ count: adminCredentials.failedLoginAttempts });
    return Number(row?.count ?? 0);
  }

  async resetFailedAttempts(id: string): Promise<void> {
    await this.db
      .update(adminCredentials)
      .set({ failedLoginAttempts: '0', lockedUntil: null })
      .where(eq(adminCredentials.id, id));
  }

  async lockUntil(id: string, until: Date): Promise<void> {
    await this.db
      .update(adminCredentials)
      .set({ lockedUntil: until })
      .where(eq(adminCredentials.id, id));
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db
      .update(adminCredentials)
      .set({
        passwordHash,
        lastPasswordChangedAt: new Date(),
        failedLoginAttempts: '0',
        lockedUntil: null,
      })
      .where(eq(adminCredentials.id, id));
  }

  async markEmailVerified(id: string): Promise<void> {
    await this.db
      .update(adminCredentials)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(adminCredentials.id, id));
  }
}
