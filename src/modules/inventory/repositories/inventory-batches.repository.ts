import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  InventoryBatchRow,
  NewInventoryBatch,
  inventoryBatches,
} from '@/db/schema/inventory-batches';

/**
 * BE-27 — `inventory_batches` data access.
 *
 * Two important reads:
 *   - `findByBatchNumber` — used to upsert on stock-in and to target
 *     a specific batch on stock-out.
 *   - `findFifoBatches` — drives the stock-out FIFO deduction, ordered
 *     by `expiryDate ASC NULLS LAST` (oldest expiry first; NULL
 *     expiry consumed last because we have no signal to act on).
 */
@Injectable()
export class InventoryBatchesRepository extends BaseRepository<
  typeof inventoryBatches,
  InventoryBatchRow,
  NewInventoryBatch,
  Partial<NewInventoryBatch>
> {
  constructor(db: DbService) {
    super(db.getDb(), inventoryBatches, 'inventory_batches');
  }

  async findByBatchNumber(
    productId: string,
    storeId: string,
    batchNumber: string,
    tx?: Transaction,
  ): Promise<InventoryBatchRow | null> {
    const scope = tx ?? this.db;
    const [row] = await scope
      .select()
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.productId, productId),
          eq(inventoryBatches.storeId, storeId),
          eq(inventoryBatches.batchNumber, batchNumber),
        ),
      )
      .limit(1);
    return (row as InventoryBatchRow | undefined) ?? null;
  }

  async findByInventoryItem(
    inventoryItemId: string,
    tx?: Transaction,
  ): Promise<InventoryBatchRow[]> {
    const scope = tx ?? this.db;
    return (await scope
      .select()
      .from(inventoryBatches)
      .where(eq(inventoryBatches.inventoryItemId, inventoryItemId))
      .orderBy(asc(inventoryBatches.expiryDate))) as InventoryBatchRow[];
  }

  /**
   * FIFO ordering for stock-out deduction. Returns batches with
   * `quantity > 0` first by oldest expiryDate, NULL expiry last,
   * ties broken by `receivedAt ASC` (FIFO on arrival when expiry is
   * tied or absent).
   */
  async findFifoBatches(
    productId: string,
    storeId: string,
    tx?: Transaction,
  ): Promise<InventoryBatchRow[]> {
    const scope = tx ?? this.db;
    return (await scope
      .select()
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.productId, productId),
          eq(inventoryBatches.storeId, storeId),
          gt(inventoryBatches.quantity, 0),
        ),
      )
      .orderBy(
        sql`${inventoryBatches.expiryDate} ASC NULLS LAST`,
        asc(inventoryBatches.receivedAt),
        asc(inventoryBatches.createdAt),
      )) as InventoryBatchRow[];
  }

  /**
   * Returns batches expiring within `withinDays` from `from` for a
   * given store. Used by the inventory summary to surface
   * "expiringSoonCount". Results are limited to those with quantity
   * remaining (a depleted batch is no longer "in stock").
   */
  async findExpiringSoonForStore(
    tenantId: string,
    storeId: string,
    from: Date,
    withinDays: number,
  ): Promise<InventoryBatchRow[]> {
    const upper = new Date(from.getTime() + withinDays * 86_400_000);
    return (await this.db
      .select()
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.tenantId, tenantId),
          eq(inventoryBatches.storeId, storeId),
          gt(inventoryBatches.quantity, 0),
          isNotNull(inventoryBatches.expiryDate),
          sql`${inventoryBatches.expiryDate} >= ${from}`,
          sql`${inventoryBatches.expiryDate} <= ${upper}`,
        ),
      )
      .orderBy(asc(inventoryBatches.expiryDate))) as InventoryBatchRow[];
  }

  async findExpiredForStore(
    tenantId: string,
    storeId: string,
    asOf: Date,
  ): Promise<InventoryBatchRow[]> {
    return (await this.db
      .select()
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.tenantId, tenantId),
          eq(inventoryBatches.storeId, storeId),
          gt(inventoryBatches.quantity, 0),
          isNotNull(inventoryBatches.expiryDate),
          sql`${inventoryBatches.expiryDate} < ${asOf}`,
        ),
      )) as InventoryBatchRow[];
  }

  /** Sum of quantities across batches for a (product, store). Used by
   *  reconciliation tests to assert sum-of-batches = item.quantity. */
  async sumQuantity(productId: string, storeId: string, tx?: Transaction): Promise<number> {
    const scope = tx ?? this.db;
    const [row] = (await scope
      .select({ total: sql<number>`coalesce(sum(${inventoryBatches.quantity}), 0)::int` })
      .from(inventoryBatches)
      .where(
        and(eq(inventoryBatches.productId, productId), eq(inventoryBatches.storeId, storeId)),
      )) as Array<{ total: number }>;
    return Number(row?.total ?? 0);
  }

  /**
   * Removes empty unbatched rows after a stock-out fully drains them.
   * Named-batch rows are preserved at `quantity = 0` for traceability.
   */
  async deleteEmptyBatches(productId: string, storeId: string, tx?: Transaction): Promise<number> {
    const scope = tx ?? this.db;
    const rows = await scope
      .delete(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.productId, productId),
          eq(inventoryBatches.storeId, storeId),
          eq(inventoryBatches.quantity, 0),
          isNull(inventoryBatches.batchNumber),
        ),
      )
      .returning({ id: inventoryBatches.id });
    return (rows as unknown as Array<unknown>).length;
  }
}
