import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import type {
  IInventoryAccuracyMetricsQuery,
  InventoryAccuracyMetrics,
  InventoryAccuracyMetricsInput,
} from '../types/integration.tokens';

/**
 * BE-30 — In-process stub for the BE-27 inventory metrics query.
 *
 * BE-27 (Inventory module) ships in the same wave as BE-30 and will
 * own the real implementation. Until the orchestrator rebinds
 * `INVENTORY_ACCURACY_METRICS_QUERY` to BE-27's
 * `InventoryAccuracyMetricsQuery`, the OHS InventoryAccuracy
 * calculator falls through to this stub.
 *
 * Returns a "neutral" payload (`varianceRate = 0`,
 * `countsPerformed = 0`). The calculator interprets that as "no
 * counts performed" and applies its zero-data fallback rather than
 * pretending the store is perfectly accurate.
 *
 * The handoff doc lists this as deferred — once BE-27 lands, swap
 * via provider override and the dashboard module is unaffected.
 */
@Injectable()
export class StubInventoryAccuracyMetricsQuery implements IInventoryAccuracyMetricsQuery {
  constructor(private readonly logger: LoggerService) {}

  async getMetrics(input: InventoryAccuracyMetricsInput): Promise<InventoryAccuracyMetrics> {
    this.logger.warn('dashboard.inventory_accuracy.stub_used', {
      reason: 'BE-27 inventory module not yet wired',
      tenantId: input.tenantId,
      storeId: input.storeId,
      windowDays: input.windowDays,
    });
    return {
      varianceRate: 0,
      countsPerformed: 0,
      windowDays: input.windowDays,
    };
  }
}
