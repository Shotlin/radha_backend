import { Injectable } from '@nestjs/common';

import { StockMovementsRepository } from '../repositories/stock-movements.repository';

/**
 * BE-27 v2 ADDENDUM — Inventory accuracy metrics for BE-30 OHS.
 *
 * Drives the "Inventory Accuracy" component of the Operational
 * Health Score (Req 29, weight 20%). Variance rate is the absolute
 * difference between counted stock and system stock at the moment
 * of the count, divided by the system stock — capped to [0, 1].
 *
 * Data source: `stock_movements.reason = 'count_adjustment'`. The
 * row carries `quantityBefore` (system stock at count time) and the
 * signed `quantity` delta. We sum |quantity| / quantityBefore across
 * the window, weighting larger counts more.
 *
 * If no counts were performed in the window, the metric returns
 * `varianceRate: 0, countsPerformed: 0`. BE-30 should treat zero
 * counts as "no signal" rather than "perfect accuracy" — that
 * decision is BE-30's, not ours.
 */
export interface InventoryAccuracyMetrics {
  /** 0..1 — lower is better. */
  varianceRate: number;
  /** Number of count-adjustment movements observed. */
  countsPerformed: number;
  windowDays: number;
}

@Injectable()
export class InventoryAccuracyMetricsQuery {
  constructor(private readonly movementsRepo: StockMovementsRepository) {}

  async forStore(
    tenantId: string,
    storeId: string,
    windowDays = 30,
  ): Promise<InventoryAccuracyMetrics> {
    const to = new Date();
    const from = new Date(to.getTime() - windowDays * 86_400_000);

    const adjustments = await this.movementsRepo.findCountAdjustmentsBetween(
      tenantId,
      storeId,
      from,
      to,
    );

    if (adjustments.length === 0) {
      return { varianceRate: 0, countsPerformed: 0, windowDays };
    }

    let sumAbsVariance = 0;
    let sumSystemStock = 0;

    for (const m of adjustments) {
      const before = Math.max(0, m.quantityBefore);
      const delta = Math.abs(m.quantity);
      sumAbsVariance += delta;
      sumSystemStock += before;
    }

    const rate =
      sumSystemStock > 0
        ? Math.min(1, sumAbsVariance / sumSystemStock)
        : sumAbsVariance > 0
          ? 1
          : 0;

    return {
      varianceRate: rate,
      countsPerformed: adjustments.length,
      windowDays,
    };
  }
}
