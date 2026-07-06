import { Inject, Injectable } from '@nestjs/common';

import type {
  ComponentInput,
  ComponentResult,
  IComponentCalculator,
  OhsComponentName,
} from '../../types/dashboard.types';
import {
  INVENTORY_ACCURACY_METRICS_QUERY,
  type IInventoryAccuracyMetricsQuery,
} from '../../types/integration.tokens';

/**
 * BE-30 v2 — Inventory accuracy component (20 % of OHS).
 *
 * Delegates to the BE-27 `IInventoryAccuracyMetricsQuery` provider
 * registered under `INVENTORY_ACCURACY_METRICS_QUERY`. Until BE-27
 * ships, the stub bound by `client-dashboard.module.ts` returns
 * `varianceRate = 0` / `countsPerformed = 0` and we apply the
 * zero-data fallback.
 *
 * Score = `1 - varianceRate` clamped to [0, 1].
 *
 * Zero-data fallback: when no physical counts have been performed
 * in the window we score 1.0, mirroring the other calculators.
 * Empty data shouldn't drag the OHS down.
 */
@Injectable()
export class InventoryAccuracyCalculator implements IComponentCalculator {
  readonly name: OhsComponentName = 'inventoryAccuracy';
  readonly weight = 0.2;

  constructor(
    @Inject(INVENTORY_ACCURACY_METRICS_QUERY)
    private readonly query: IInventoryAccuracyMetricsQuery,
  ) {}

  async compute(input: ComponentInput): Promise<ComponentResult> {
    const metrics = await this.query.getMetrics({
      tenantId: input.tenantId,
      storeId: input.storeId,
      asOf: input.asOf,
      windowDays: 30,
    });

    const rawScore = metrics.countsPerformed > 0 ? clamp01(1 - metrics.varianceRate) : 1;

    return {
      rawScore,
      rawInputs: {
        windowDays: metrics.windowDays,
        varianceRate: metrics.varianceRate,
        countsPerformed: metrics.countsPerformed,
      },
    };
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
