import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewObfCacheRow, ObfCacheRow, openBeautyFactsCache } from '@/db/schema/obf-cache';

@Injectable()
export class ObfCacheRepository extends BaseRepository<
  typeof openBeautyFactsCache,
  ObfCacheRow,
  NewObfCacheRow,
  Partial<NewObfCacheRow>
> {
  constructor(db: DbService) {
    super(db.getDb(), openBeautyFactsCache, 'open_beauty_facts_cache');
  }

  async findByEan(ean: string): Promise<ObfCacheRow | null> {
    const [row] = await this.db
      .select()
      .from(openBeautyFactsCache)
      .where(eq(openBeautyFactsCache.ean, ean))
      .limit(1);
    return (row as ObfCacheRow | undefined) ?? null;
  }

  async upsert(row: NewObfCacheRow): Promise<ObfCacheRow> {
    const existing = await this.findByEan(row.ean);
    if (!existing) {
      return this.create(row);
    }
    const [updated] = await this.db
      .update(openBeautyFactsCache)
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
      .where(eq(openBeautyFactsCache.ean, row.ean))
      .returning();
    return updated as ObfCacheRow;
  }

  async incrementHit(ean: string): Promise<void> {
    await this.db
      .update(openBeautyFactsCache)
      .set({
        hitCount: sql`${openBeautyFactsCache.hitCount} + 1`,
        lastAccessedAt: new Date(),
      })
      .where(eq(openBeautyFactsCache.ean, ean));
  }

  async invalidate(ean: string): Promise<void> {
    await this.db.delete(openBeautyFactsCache).where(eq(openBeautyFactsCache.ean, ean));
  }
}
