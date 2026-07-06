import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewStockCount, StockCountRow, stockCounts } from '@/db/schema/stock-counts';

import type { StockCountStatus } from '../types/inventory.types';

/**
 * BE-27 — `stock_counts` data access.
 *
 * `updateStatusGuarded` mirrors the GRN module's guarded transition
 * pattern so concurrent "complete this count" requests can't both
 * succeed.
 */
@Injectable()
export class StockCountsRepository extends BaseRepository<
  typeof stockCounts,
  StockCountRow,
  NewStockCount,
  Partial<NewStockCount>
> {
  constructor(db: DbService) {
    super(db.getDb(), stockCounts, 'stock_counts');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<StockCountRow | null> {
    const [row] = await this.db
      .select()
      .from(stockCounts)
      .where(and(eq(stockCounts.id, id), eq(stockCounts.tenantId, tenantId)))
      .limit(1);
    return (row as StockCountRow | undefined) ?? null;
  }

  async listForStore(tenantId: string, storeId: string, limit = 50): Promise<StockCountRow[]> {
    return (await this.db
      .select()
      .from(stockCounts)
      .where(and(eq(stockCounts.tenantId, tenantId), eq(stockCounts.storeId, storeId)))
      .orderBy(desc(stockCounts.startedAt))
      .limit(limit)) as StockCountRow[];
  }

  async updateStatusGuarded(
    id: string,
    allowedFromStates: StockCountStatus[],
    patch: Partial<NewStockCount>,
    tx?: Transaction,
  ): Promise<StockCountRow | null> {
    const scope = tx ?? this.db;
    const [row] = await scope
      .update(stockCounts)
      .set({ ...patch, updatedAt: new Date() } as never)
      .where(and(eq(stockCounts.id, id), inArray(stockCounts.status, allowedFromStates)))
      .returning();
    return (row as StockCountRow | undefined) ?? null;
  }
}
