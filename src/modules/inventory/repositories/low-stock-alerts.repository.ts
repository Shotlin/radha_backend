import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { LowStockAlertRow, NewLowStockAlert, lowStockAlerts } from '@/db/schema/low-stock-alerts';

/**
 * BE-27 — `low_stock_alerts` data access.
 *
 * Alerts are scoped tightly: the active alert for a (productId,
 * storeId) pair is unique by partial index, so `findActiveForItem`
 * is guaranteed to return at most one row.
 */
@Injectable()
export class LowStockAlertsRepository extends BaseRepository<
  typeof lowStockAlerts,
  LowStockAlertRow,
  NewLowStockAlert,
  Partial<NewLowStockAlert>
> {
  constructor(db: DbService) {
    super(db.getDb(), lowStockAlerts, 'low_stock_alerts');
  }

  async findActiveForItem(
    productId: string,
    storeId: string,
    tx?: Transaction,
  ): Promise<LowStockAlertRow | null> {
    const scope = tx ?? this.db;
    const [row] = await scope
      .select()
      .from(lowStockAlerts)
      .where(
        and(
          eq(lowStockAlerts.productId, productId),
          eq(lowStockAlerts.storeId, storeId),
          isNull(lowStockAlerts.resolvedAt),
        ),
      )
      .limit(1);
    return (row as LowStockAlertRow | undefined) ?? null;
  }

  async listActiveForStore(tenantId: string, storeId: string): Promise<LowStockAlertRow[]> {
    return (await this.db
      .select()
      .from(lowStockAlerts)
      .where(
        and(
          eq(lowStockAlerts.tenantId, tenantId),
          eq(lowStockAlerts.storeId, storeId),
          isNull(lowStockAlerts.resolvedAt),
        ),
      )
      .orderBy(desc(lowStockAlerts.createdAt))) as LowStockAlertRow[];
  }

  /**
   * Idempotent: if an active alert already exists for the
   * (productId, storeId) pair, returns it without creating a
   * duplicate. Otherwise creates a new alert row. The partial
   * unique index on (productId, storeId) WHERE resolvedAt IS NULL
   * is the storage-level guard.
   */
  async createIfNotActive(
    input: NewLowStockAlert,
    tx?: Transaction,
  ): Promise<{ alert: LowStockAlertRow; created: boolean }> {
    const existing = await this.findActiveForItem(input.productId, input.storeId, tx);
    if (existing) return { alert: existing, created: false };
    const created = await this.create(input, tx);
    return { alert: created, created: true };
  }

  async resolveForItem(productId: string, storeId: string, tx?: Transaction): Promise<number> {
    const scope = tx ?? this.db;
    const rows = await scope
      .update(lowStockAlerts)
      .set({ resolvedAt: new Date(), updatedAt: new Date() } as never)
      .where(
        and(
          eq(lowStockAlerts.productId, productId),
          eq(lowStockAlerts.storeId, storeId),
          isNull(lowStockAlerts.resolvedAt),
        ),
      )
      .returning({ id: lowStockAlerts.id });
    return (rows as unknown as Array<unknown>).length;
  }

  async markNotified(id: string, tx?: Transaction): Promise<void> {
    const scope = tx ?? this.db;
    await scope
      .update(lowStockAlerts)
      .set({ notifiedAt: new Date(), updatedAt: new Date() } as never)
      .where(eq(lowStockAlerts.id, id));
  }
}
