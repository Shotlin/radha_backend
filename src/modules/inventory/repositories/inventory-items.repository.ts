import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { decodeCursor, encodeCursor } from '@/db/repositories/pagination.utils';
import { InventoryItemRow, NewInventoryItem, inventoryItems } from '@/db/schema/inventory-items';

import type { ListInventoryFilters, PaginatedResult } from '../types/inventory.types';

/**
 * BE-27 — `inventory_items` data access.
 *
 * The (productId, storeId) row is the single source of truth for the
 * "current quantity" of a product in a store. Reads are ALWAYS scoped
 * to a tenant.
 */
@Injectable()
export class InventoryItemsRepository extends BaseRepository<
  typeof inventoryItems,
  InventoryItemRow,
  NewInventoryItem,
  Partial<NewInventoryItem>
> {
  constructor(db: DbService) {
    super(db.getDb(), inventoryItems, 'inventory_items');
  }

  /**
   * Find by (productId, storeId). The unique index on this pair makes
   * this the canonical "do I have stock for X here" lookup.
   */
  async findByProductAndStore(
    productId: string,
    storeId: string,
    tx?: Transaction,
  ): Promise<InventoryItemRow | null> {
    const scope = tx ?? this.db;
    const [row] = await scope
      .select()
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.productId, productId),
          eq(inventoryItems.storeId, storeId),
          isNull(inventoryItems.deletedAt),
        ),
      )
      .limit(1);
    return (row as InventoryItemRow | undefined) ?? null;
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<InventoryItemRow | null> {
    const [row] = await this.db
      .select()
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.id, id),
          eq(inventoryItems.tenantId, tenantId),
          isNull(inventoryItems.deletedAt),
        ),
      )
      .limit(1);
    return (row as InventoryItemRow | undefined) ?? null;
  }

  async findPaginatedScoped(
    tenantId: string,
    filters: ListInventoryFilters,
  ): Promise<PaginatedResult<InventoryItemRow>> {
    const conds = [eq(inventoryItems.tenantId, tenantId), isNull(inventoryItems.deletedAt)];
    if (filters.storeId) conds.push(eq(inventoryItems.storeId, filters.storeId));
    if (filters.productId) conds.push(eq(inventoryItems.productId, filters.productId));
    if (filters.isLowStock !== undefined) {
      conds.push(eq(inventoryItems.isLowStock, filters.isLowStock ? 1 : 0));
    }

    if (filters.cursor) {
      const cursor = decodeCursor(filters.cursor);
      if (cursor && cursor.createdAt !== undefined) {
        conds.push(sql`${inventoryItems.createdAt} < ${new Date(cursor.createdAt as string)}`);
      }
    }

    const limit = filters.limit ?? 50;
    const rows = (await this.db
      .select()
      .from(inventoryItems)
      .where(and(...conds))
      .orderBy(desc(inventoryItems.createdAt))
      .limit(limit + 1)) as InventoryItemRow[];

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

  /**
   * Quick aggregate for a store. Returns count of distinct products
   * and total quantity. Used by the dashboard summary endpoint.
   */
  async aggregateForStore(
    tenantId: string,
    storeId: string,
  ): Promise<{
    totalProducts: number;
    totalQuantity: number;
    lowStockCount: number;
  }> {
    const conds = [
      eq(inventoryItems.tenantId, tenantId),
      eq(inventoryItems.storeId, storeId),
      isNull(inventoryItems.deletedAt),
    ];

    const [agg] = (await this.db
      .select({
        totalProducts: sql<number>`count(*)::int`,
        totalQuantity: sql<number>`coalesce(sum(${inventoryItems.quantity}), 0)::int`,
        lowStockCount: sql<number>`coalesce(sum(case when ${inventoryItems.isLowStock} = 1 then 1 else 0 end), 0)::int`,
      })
      .from(inventoryItems)
      .where(and(...conds))) as Array<{
      totalProducts: number;
      totalQuantity: number;
      lowStockCount: number;
    }>;

    return {
      totalProducts: Number(agg?.totalProducts ?? 0),
      totalQuantity: Number(agg?.totalQuantity ?? 0),
      lowStockCount: Number(agg?.lowStockCount ?? 0),
    };
  }

  async listForStore(tenantId: string, storeId: string): Promise<InventoryItemRow[]> {
    return (await this.db
      .select()
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.tenantId, tenantId),
          eq(inventoryItems.storeId, storeId),
          isNull(inventoryItems.deletedAt),
        ),
      )
      .orderBy(desc(inventoryItems.lastMovementAt))) as InventoryItemRow[];
  }
}
