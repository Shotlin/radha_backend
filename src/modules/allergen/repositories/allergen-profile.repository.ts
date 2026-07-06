import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { allergenProfiles, NewAllergenProfile } from '@/db/schema/allergen-profiles';

/**
 * BE-37 — Allergen profile Drizzle repository.
 * No business logic — only database queries.
 */
@Injectable()
export class AllergenProfileRepository {
  constructor(private readonly db: DbService) {}

  async countByUser(tenantId: string, userId: string): Promise<number> {
    const result = await this.db
      .getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(allergenProfiles)
      .where(
        and(
          eq(allergenProfiles.tenantId, tenantId),
          eq(allergenProfiles.userId, userId),
          isNull(allergenProfiles.deletedAt),
        ),
      );
    return result[0]?.count ?? 0;
  }

  async findById(id: string, tenantId: string) {
    const rows = await this.db
      .getDb()
      .select()
      .from(allergenProfiles)
      .where(
        and(
          eq(allergenProfiles.id, id),
          eq(allergenProfiles.tenantId, tenantId),
          isNull(allergenProfiles.deletedAt),
        ),
      );
    return rows[0] ?? null;
  }

  async findByUser(tenantId: string, userId: string) {
    return this.db
      .getDb()
      .select()
      .from(allergenProfiles)
      .where(
        and(
          eq(allergenProfiles.tenantId, tenantId),
          eq(allergenProfiles.userId, userId),
          isNull(allergenProfiles.deletedAt),
        ),
      )
      .orderBy(allergenProfiles.createdAt);
  }

  async create(data: NewAllergenProfile) {
    const rows = await this.db.getDb().insert(allergenProfiles).values(data).returning();
    return rows[0];
  }

  async update(
    id: string,
    tenantId: string,
    data: Partial<Omit<NewAllergenProfile, 'id' | 'tenantId' | 'userId' | 'createdAt'>>,
  ) {
    const rows = await this.db
      .getDb()
      .update(allergenProfiles)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(allergenProfiles.id, id), eq(allergenProfiles.tenantId, tenantId)))
      .returning();
    return rows[0] ?? null;
  }

  async softDelete(id: string, tenantId: string) {
    const rows = await this.db
      .getDb()
      .update(allergenProfiles)
      .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(allergenProfiles.id, id),
          eq(allergenProfiles.tenantId, tenantId),
          isNull(allergenProfiles.deletedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async setActive(id: string, tenantId: string, userId: string) {
    // Deactivate all other profiles for this user
    await this.db
      .getDb()
      .update(allergenProfiles)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(allergenProfiles.tenantId, tenantId),
          eq(allergenProfiles.userId, userId),
          isNull(allergenProfiles.deletedAt),
        ),
      );

    // Activate the target profile
    const rows = await this.db
      .getDb()
      .update(allergenProfiles)
      .set({ isActive: true, updatedAt: new Date() })
      .where(
        and(
          eq(allergenProfiles.id, id),
          eq(allergenProfiles.tenantId, tenantId),
          isNull(allergenProfiles.deletedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }
}
