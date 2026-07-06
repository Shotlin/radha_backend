import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { decodeCursor, encodeCursor } from '@/db/repositories/pagination.utils';
import { NewStockMovement, StockMovementRow, stockMovements } from '@/db/schema/stock-movements';

import type {
  MovementHistoryFilters,
  PaginatedResult,
  StockMovementType,
} from '../types/inventory.types';

/**
 * BE-27 — `stock_movements` data access. Append-only.
 *
 * Movements are NEVER updated or deleted. The base repository's
 * mutation helpers exist but are intentionally unused for movements.
 * Reads are always scoped to a tenant; the indexed columns are
 * `(productId, storeId, createdAt)` and `(storeId, createdAt)` so
 * the most common cursor pagination patterns are covered without an
 * additional sort key beyond `createdAt`.
 */
@Injectable()
export class StockMovementsRepository extends BaseRepository<
  typeof stockMovements,
  StockMovementRow,
  NewStockMovement,
  Partial<NewStockMovement>
> {
  constructor(db: DbService) {
    super(db.getDb(), stockMovements, 'stock_movements');
  }

  async findPaginatedScoped(
    tenantId: string,
    filters: MovementHistoryFilters,
  ): Promise<PaginatedResult<StockMovementRow>> {
    const conds = [eq(stockMovements.tenantId, tenantId)];
    if (filters.storeId) conds.push(eq(stockMovements.storeId, filters.storeId));
    if (filters.productId) conds.push(eq(stockMovements.productId, filters.productId));
    if (filters.type) conds.push(eq(stockMovements.type, filters.type));
    if (filters.reason) conds.push(eq(stockMovements.reason, filters.reason));
    if (filters.fromDate) conds.push(gte(stockMovements.createdAt, filters.fromDate));
    if (filters.toDate) conds.push(lte(stockMovements.createdAt, filters.toDate));

    if (filters.cursor) {
      const cursor = decodeCursor(filters.cursor);
      if (cursor && cursor.createdAt !== undefined) {
        conds.push(sql`${stockMovements.createdAt} < ${new Date(cursor.createdAt as string)}`);
      }
    }

    const limit = filters.limit ?? 50;
    const rows = (await this.db
      .select()
      .from(stockMovements)
      .where(and(...conds))
      .orderBy(desc(stockMovements.createdAt))
      .limit(limit + 1)) as StockMovementRow[];

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, -1) : rows;
    const last = data[data.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor(last as unknown as Record<string, unknown>, [
            { field: 'createdAt', direction: 'desc' },
          ])
        : null;
    return { data, nextCursor, hasMore };
  }

  async listForProduct(
    tenantId: string,
    productId: string,
    storeId: string,
    limit = 100,
  ): Promise<StockMovementRow[]> {
    return (await this.db
      .select()
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.tenantId, tenantId),
          eq(stockMovements.productId, productId),
          eq(stockMovements.storeId, storeId),
        ),
      )
      .orderBy(desc(stockMovements.createdAt))
      .limit(limit)) as StockMovementRow[];
  }

  /** Counts movements between two dates per type. Used by aggregator. */
  async countByTypeBetween(
    tenantId: string,
    storeId: string,
    from: Date,
    to: Date,
  ): Promise<Record<StockMovementType, number>> {
    const conds = [
      eq(stockMovements.tenantId, tenantId),
      eq(stockMovements.storeId, storeId),
      gte(stockMovements.createdAt, from),
      lte(stockMovements.createdAt, to),
    ];
    const rows = (await this.db
      .select({
        type: stockMovements.type,
        count: sql<number>`count(*)::int`,
      })
      .from(stockMovements)
      .where(and(...conds))
      .groupBy(stockMovements.type)) as Array<{ type: StockMovementType; count: number }>;

    const out: Record<StockMovementType, number> = {
      in: 0,
      out: 0,
      adjustment: 0,
      transfer: 0,
    };
    for (const r of rows) out[r.type] = Number(r.count);
    return out;
  }

  /**
   * Used by `InventoryAccuracyMetricsQuery` (BE-30 OHS): returns all
   * count_adjustment movements within a window so the query can
   * aggregate the variance ratio.
   */
  async findCountAdjustmentsBetween(
    tenantId: string,
    storeId: string,
    from: Date,
    to: Date,
  ): Promise<StockMovementRow[]> {
    return (await this.db
      .select()
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.tenantId, tenantId),
          eq(stockMovements.storeId, storeId),
          eq(stockMovements.reason, 'count_adjustment'),
          gte(stockMovements.createdAt, from),
          lte(stockMovements.createdAt, to),
        ),
      )) as StockMovementRow[];
  }
}
