import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import type { PaginatedResult } from '@/db/repositories/base.repository.types';
import { decodeCursor, encodeCursor } from '@/db/repositories/pagination.utils';
import { GrnHeaderRow, NewGrnHeader, grnHeaders } from '@/db/schema/grn';

import type { GrnStats, GrnStatus, ListGrnFilters } from '../types/grn.types';

/**
 * BE-26 — `grn_headers` data access.
 *
 * Wraps `BaseRepository` and adds:
 *   - `findByIdInTenant`     : tenant-scoped read used by every public path.
 *   - `findByInvoice`        : duplicate-invoice detection.
 *   - `findPaginatedScoped`  : cursor pagination with full filter set.
 *   - `getStats`             : single GROUP BY query for the dashboard.
 */
@Injectable()
export class GrnHeadersRepository extends BaseRepository<
  typeof grnHeaders,
  GrnHeaderRow,
  NewGrnHeader,
  Partial<NewGrnHeader>
> {
  constructor(db: DbService) {
    super(db.getDb(), grnHeaders, 'grn_headers');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<GrnHeaderRow | null> {
    const [row] = await this.db
      .select()
      .from(grnHeaders)
      .where(
        and(eq(grnHeaders.id, id), eq(grnHeaders.tenantId, tenantId), isNull(grnHeaders.deletedAt)),
      )
      .limit(1);
    return (row as GrnHeaderRow | undefined) ?? null;
  }

  /**
   * Used for duplicate-invoice prevention. The DB-level unique index
   * is the hard guard; this method gives the service layer a clean
   * 409 error before the insert is attempted.
   */
  async findByInvoice(supplierId: string, invoiceNumber: string): Promise<GrnHeaderRow | null> {
    const [row] = await this.db
      .select()
      .from(grnHeaders)
      .where(
        and(
          eq(grnHeaders.supplierId, supplierId),
          eq(grnHeaders.invoiceNumber, invoiceNumber),
          isNull(grnHeaders.deletedAt),
        ),
      )
      .limit(1);
    return (row as GrnHeaderRow | undefined) ?? null;
  }

  async findPaginatedScoped(
    tenantId: string,
    filters: ListGrnFilters,
  ): Promise<PaginatedResult<GrnHeaderRow>> {
    const conditions = [eq(grnHeaders.tenantId, tenantId), isNull(grnHeaders.deletedAt)];
    if (filters.storeId) conditions.push(eq(grnHeaders.storeId, filters.storeId));
    if (filters.supplierId) conditions.push(eq(grnHeaders.supplierId, filters.supplierId));
    if (filters.status?.length) conditions.push(inArray(grnHeaders.status, filters.status));
    if (filters.invoiceNumber) conditions.push(eq(grnHeaders.invoiceNumber, filters.invoiceNumber));
    if (filters.fromDate) conditions.push(gte(grnHeaders.inwardDate, filters.fromDate));
    if (filters.toDate) conditions.push(lte(grnHeaders.inwardDate, filters.toDate));

    if (filters.cursor) {
      const cursor = decodeCursor(filters.cursor);
      if (cursor && cursor.inwardDate !== undefined) {
        // We sort by inwardDate desc, createdAt desc. The cursor
        // captures inwardDate so we resume cleanly.
        const cursorVal = new Date(cursor.inwardDate as string | number);
        conditions.push(sql`${grnHeaders.inwardDate} < ${cursorVal}`);
      }
    }

    const limit = filters.limit ?? 50;
    const rows = (await this.db
      .select()
      .from(grnHeaders)
      .where(and(...conditions))
      .orderBy(desc(grnHeaders.inwardDate), desc(grnHeaders.createdAt))
      .limit(limit + 1)) as GrnHeaderRow[];

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, -1) : rows;
    const last = data[data.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor(last as unknown as Record<string, unknown>, [
            { field: 'inwardDate', direction: 'desc' },
          ])
        : null;
    return { data, nextCursor, hasMore };
  }

  /**
   * Optimistic state guard — only flips status if the row is still
   * in one of `allowedFromStates`. Returns the updated row, or null
   * if the guard rejected the update. Used by the posting service to
   * prevent double-posts at the storage layer.
   */
  async updateStatusGuarded(
    id: string,
    allowedFromStates: GrnStatus[],
    patch: Partial<NewGrnHeader>,
    tx?: Transaction,
  ): Promise<GrnHeaderRow | null> {
    const scope = tx ?? this.db;
    const [row] = await scope
      .update(grnHeaders)
      .set({ ...patch, updatedAt: new Date() } as never)
      .where(
        and(
          eq(grnHeaders.id, id),
          inArray(grnHeaders.status, allowedFromStates),
          isNull(grnHeaders.deletedAt),
        ),
      )
      .returning();
    return (row as GrnHeaderRow | undefined) ?? null;
  }

  async getStats(
    tenantId: string,
    storeId: string | null,
    fromDate?: Date,
    toDate?: Date,
  ): Promise<GrnStats> {
    const baseConds = [eq(grnHeaders.tenantId, tenantId), isNull(grnHeaders.deletedAt)];
    if (storeId) baseConds.push(eq(grnHeaders.storeId, storeId));
    if (fromDate) baseConds.push(gte(grnHeaders.inwardDate, fromDate));
    if (toDate) baseConds.push(lte(grnHeaders.inwardDate, toDate));

    const statusRows = (await this.db
      .select({
        status: grnHeaders.status,
        count: sql<number>`count(*)::int`,
      })
      .from(grnHeaders)
      .where(and(...baseConds))
      .groupBy(grnHeaders.status)) as Array<{ status: GrnStatus; count: number }>;

    const [agg] = (await this.db
      .select({
        total: sql<number>`count(*)::int`,
        totalAmount: sql<number>`coalesce(sum(${grnHeaders.totalAmount}), 0)::float`,
        totalItems: sql<number>`coalesce(sum(${grnHeaders.totalItems}), 0)::int`,
        totalQuantity: sql<number>`coalesce(sum(${grnHeaders.totalQuantity}), 0)::int`,
        shortShelfLifeCount: sql<number>`coalesce(sum(${grnHeaders.shortShelfLifeCount}), 0)::int`,
      })
      .from(grnHeaders)
      .where(and(...baseConds))) as Array<{
      total: number;
      totalAmount: number;
      totalItems: number;
      totalQuantity: number;
      shortShelfLifeCount: number;
    }>;

    const byStatus: Record<GrnStatus, number> = {
      draft: 0,
      pending_review: 0,
      posted: 0,
      cancelled: 0,
      reversed: 0,
    };
    for (const r of statusRows) byStatus[r.status] = Number(r.count);

    return {
      storeId,
      total: Number(agg?.total ?? 0),
      byStatus,
      totalAmount: Number(agg?.totalAmount ?? 0),
      totalItems: Number(agg?.totalItems ?? 0),
      totalQuantity: Number(agg?.totalQuantity ?? 0),
      shortShelfLifeCount: Number(agg?.shortShelfLifeCount ?? 0),
    };
  }

  /** Convenience wrapper for tests / the service layer when the
   * tenant filter has already been applied upstream. */
  async listForTenant(
    tenantId: string,
    storeId: string | null,
    limit = 50,
  ): Promise<GrnHeaderRow[]> {
    const conds = [eq(grnHeaders.tenantId, tenantId), isNull(grnHeaders.deletedAt)];
    if (storeId) conds.push(eq(grnHeaders.storeId, storeId));
    return (await this.db
      .select()
      .from(grnHeaders)
      .where(and(...conds))
      .orderBy(asc(grnHeaders.inwardDate))
      .limit(limit)) as GrnHeaderRow[];
  }
}
