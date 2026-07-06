import { Injectable } from '@nestjs/common';
import { and, eq, gte, isNull, lte, inArray, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { savedProducts, SavedProductRow } from '@/db/schema/saved-products';

@Injectable()
export class ExpiryCalendarRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Find active (non-consumed) saved products for a user within a date range.
   */
  async findActiveByUserInRange(
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<SavedProductRow[]> {
    return this.db.getDb()
      .select()
      .from(savedProducts)
      .where(
        and(
          eq(savedProducts.userId, userId),
          isNull(savedProducts.markedConsumedAt),
          gte(savedProducts.expiresAt, startDate),
          lte(savedProducts.expiresAt, endDate),
        ),
      );
  }

  /**
   * Find active saved products for multiple users within a date range (family sharing).
   */
  async findActiveByUsersInRange(
    userIds: string[],
    startDate: string,
    endDate: string,
  ): Promise<SavedProductRow[]> {
    if (userIds.length === 0) return [];
    return this.db.getDb()
      .select()
      .from(savedProducts)
      .where(
        and(
          inArray(savedProducts.userId, userIds),
          isNull(savedProducts.markedConsumedAt),
          gte(savedProducts.expiresAt, startDate),
          lte(savedProducts.expiresAt, endDate),
        ),
      );
  }

  /**
   * Find active saved products for a user (regardless of date), limited count.
   * Used for free consumer who has a cap of 5 saved products.
   */
  async findActiveByUser(userId: string, limit?: number): Promise<SavedProductRow[]> {
    let query = this.db.getDb()
      .select()
      .from(savedProducts)
      .where(
        and(
          eq(savedProducts.userId, userId),
          isNull(savedProducts.markedConsumedAt),
        ),
      )
      .$dynamic();

    if (limit !== undefined) {
      query = query.limit(limit);
    }

    return query;
  }

  /**
   * Count active saved products for a user.
   */
  async countActiveByUser(userId: string): Promise<number> {
    const result = await this.db.getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(savedProducts)
      .where(
        and(
          eq(savedProducts.userId, userId),
          isNull(savedProducts.markedConsumedAt),
        ),
      );
    return result[0]?.count ?? 0;
  }

  /**
   * Find a single saved product by id owned by one of the specified users.
   */
  async findByIdForUsers(id: string, userIds: string[]): Promise<SavedProductRow | undefined> {
    const rows = await this.db.getDb()
      .select()
      .from(savedProducts)
      .where(
        and(
          eq(savedProducts.id, id),
          inArray(savedProducts.userId, userIds),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Mark a saved product as consumed.
   */
  async markConsumed(id: string): Promise<SavedProductRow | undefined> {
    const rows = await this.db.getDb()
      .update(savedProducts)
      .set({
        markedConsumedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(savedProducts.id, id))
      .returning();
    return rows[0];
  }

  /**
   * Hard-remove a saved product.
   */
  async remove(id: string): Promise<boolean> {
    const rows = await this.db.getDb()
      .delete(savedProducts)
      .where(eq(savedProducts.id, id))
      .returning({ id: savedProducts.id });
    return rows.length > 0;
  }
}
