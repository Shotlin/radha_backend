import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  NewStockCountLine,
  StockCountLineRow,
  stockCountLines,
} from '@/db/schema/stock-count-lines';

/**
 * BE-27 — `stock_count_lines` data access.
 *
 * Lines cascade-delete with their parent count. Listing is always
 * scoped by the count id (callers always know which count they're
 * looking at).
 */
@Injectable()
export class StockCountLinesRepository extends BaseRepository<
  typeof stockCountLines,
  StockCountLineRow,
  NewStockCountLine,
  Partial<NewStockCountLine>
> {
  constructor(db: DbService) {
    super(db.getDb(), stockCountLines, 'stock_count_lines');
  }

  async findByCount(stockCountId: string, tx?: Transaction): Promise<StockCountLineRow[]> {
    const scope = tx ?? this.db;
    return (await scope
      .select()
      .from(stockCountLines)
      .where(eq(stockCountLines.stockCountId, stockCountId))
      .orderBy(asc(stockCountLines.createdAt))) as StockCountLineRow[];
  }

  async findByCountAndProduct(
    stockCountId: string,
    productId: string,
    tx?: Transaction,
  ): Promise<StockCountLineRow | null> {
    const scope = tx ?? this.db;
    const [row] = await scope
      .select()
      .from(stockCountLines)
      .where(
        and(
          eq(stockCountLines.stockCountId, stockCountId),
          eq(stockCountLines.productId, productId),
        ),
      )
      .limit(1);
    return (row as StockCountLineRow | undefined) ?? null;
  }

  async upsertForProduct(
    stockCountId: string,
    productId: string,
    insert: NewStockCountLine,
    patch: Partial<NewStockCountLine>,
    tx?: Transaction,
  ): Promise<StockCountLineRow> {
    const existing = await this.findByCountAndProduct(stockCountId, productId, tx);
    if (existing) {
      return this.update(existing.id, patch, tx);
    }
    return this.create(insert, tx);
  }
}
