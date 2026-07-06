import { Injectable } from '@nestjs/common';

import { InventoryBatchesRepository } from '../repositories/inventory-batches.repository';
import { InventoryItemsRepository } from '../repositories/inventory-items.repository';
import { LowStockAlertsRepository } from '../repositories/low-stock-alerts.repository';
import { CategoryBreakdownEntry, InventorySummary } from '../types/inventory.types';

const EXPIRING_SOON_DAYS = 30;

/**
 * BE-27 — Read-only aggregations for the dashboard.
 *
 * Computes the per-store summary card (totals, low-stock count,
 * expiring-soon, expired) and a category breakdown. The category
 * grouping is currently a flat single-level. Until the products
 * module exposes a category lookup we group everything under
 * `'uncategorized'` — flagged in the integration checklist.
 */
@Injectable()
export class InventoryAggregatorService {
  constructor(
    private readonly itemsRepo: InventoryItemsRepository,
    private readonly batchesRepo: InventoryBatchesRepository,
    private readonly alertsRepo: LowStockAlertsRepository,
  ) {}

  async storeSummary(tenantId: string, storeId: string): Promise<InventorySummary> {
    const [agg, alerts, expiringSoon, expired] = await Promise.all([
      this.itemsRepo.aggregateForStore(tenantId, storeId),
      this.alertsRepo.listActiveForStore(tenantId, storeId),
      this.batchesRepo.findExpiringSoonForStore(tenantId, storeId, new Date(), EXPIRING_SOON_DAYS),
      this.batchesRepo.findExpiredForStore(tenantId, storeId, new Date()),
    ]);

    return {
      storeId,
      totalProducts: agg.totalProducts,
      totalQuantity: agg.totalQuantity,
      // Valuation deferred until product cost-of-goods is wired.
      totalValue: null,
      byCategory: { uncategorized: { count: agg.totalProducts, quantity: agg.totalQuantity } },
      lowStockCount: alerts.length,
      expiringSoonCount: expiringSoon.length,
      expiredCount: expired.length,
    };
  }

  /**
   * Flat category breakdown. Until the products module exposes a
   * category-id-to-name resolver we report a single 'uncategorized'
   * bucket. The shape is stable so the Mobile_App / dashboard can
   * render the table today.
   */
  async categoryBreakdown(tenantId: string, storeId: string): Promise<CategoryBreakdownEntry[]> {
    const items = await this.itemsRepo.listForStore(tenantId, storeId);
    if (items.length === 0) return [];
    const totalQuantity = items.reduce((s, i) => s + i.quantity, 0);
    return [
      {
        category: 'uncategorized',
        productCount: items.length,
        totalQuantity,
      },
    ];
  }
}
