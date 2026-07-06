import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewOffCacheRow, OffCacheRow, openFoodFactsCache } from '@/db/schema/off-cache';

@Injectable()
export class OffCacheRepository extends BaseRepository<
  typeof openFoodFactsCache,
  OffCacheRow,
  NewOffCacheRow,
  Partial<NewOffCacheRow>
> {
  constructor(db: DbService) {
    super(db.getDb(), openFoodFactsCache, 'open_food_facts_cache');
  }

  async findByEan(ean: string): Promise<OffCacheRow | null> {
    const [row] = await this.db
      .select()
      .from(openFoodFactsCache)
      .where(eq(openFoodFactsCache.ean, ean))
      .limit(1);
    return (row as OffCacheRow | undefined) ?? null;
  }

  async upsert(row: NewOffCacheRow): Promise<OffCacheRow> {
    const existing = await this.findByEan(row.ean);
    if (!existing) {
      return this.create(row);
    }
    const [updated] = await this.db
      .update(openFoodFactsCache)
      .set({
        rawData: row.rawData,
        productName: row.productName,
        brand: row.brand,
        fetchedAt: row.fetchedAt ?? new Date(),
        expiresAt: row.expiresAt,
        fetchSuccess: row.fetchSuccess ?? true,
        apiVersion: row.apiVersion ?? 'v2',
        lastAccessedAt: new Date(),
      })
      .where(eq(openFoodFactsCache.ean, row.ean))
      .returning();
    return updated as OffCacheRow;
  }

  async incrementHit(ean: string): Promise<void> {
    await this.db
      .update(openFoodFactsCache)
      .set({
        hitCount: sql`${openFoodFactsCache.hitCount} + 1`,
        lastAccessedAt: new Date(),
      })
      .where(eq(openFoodFactsCache.ean, ean));
  }

  async invalidate(ean: string): Promise<void> {
    await this.db.delete(openFoodFactsCache).where(eq(openFoodFactsCache.ean, ean));
  }
}
