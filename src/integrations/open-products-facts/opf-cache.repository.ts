import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewOpfCacheRow, OpfCacheRow, openProductsFactsCache } from '@/db/schema/opf-cache';

@Injectable()
export class OpfCacheRepository extends BaseRepository<
  typeof openProductsFactsCache,
  OpfCacheRow,
  NewOpfCacheRow,
  Partial<NewOpfCacheRow>
> {
  constructor(db: DbService) {
    super(db.getDb(), openProductsFactsCache, 'open_products_facts_cache');
  }

  async findByEan(ean: string): Promise<OpfCacheRow | null> {
    const [row] = await this.db
      .select()
      .from(openProductsFactsCache)
      .where(eq(openProductsFactsCache.ean, ean))
      .limit(1);
    return (row as OpfCacheRow | undefined) ?? null;
  }

  async upsert(row: NewOpfCacheRow): Promise<OpfCacheRow> {
    const existing = await this.findByEan(row.ean);
    if (!existing) {
      return this.create(row);
    }
    const [updated] = await this.db
      .update(openProductsFactsCache)
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
      .where(eq(openProductsFactsCache.ean, row.ean))
      .returning();
    return updated as OpfCacheRow;
  }

  async incrementHit(ean: string): Promise<void> {
    await this.db
      .update(openProductsFactsCache)
      .set({
        hitCount: sql`${openProductsFactsCache.hitCount} + 1`,
        lastAccessedAt: new Date(),
      })
      .where(eq(openProductsFactsCache.ean, ean));
  }

  async invalidate(ean: string): Promise<void> {
    await this.db.delete(openProductsFactsCache).where(eq(openProductsFactsCache.ean, ean));
  }
}
