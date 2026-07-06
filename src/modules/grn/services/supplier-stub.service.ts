import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import type {
  ISupplierLookupService,
  ISupplierPerformanceService,
  SupplierLookupRow,
  SupplierPerformanceMetrics,
} from '../types/grn.types';

/**
 * BE-26 — In-process stubs for the BE-25 supplier contracts.
 *
 * The real implementations live in `modules/suppliers/`. BE-25 lands
 * in the same wave as BE-26; until it's merged, these stubs let the
 * GRN module boot and run end-to-end with synthetic supplier reads.
 *
 * `SupplierLookupStubService.findById`:
 *   - returns `null` for an unknown id so the create-draft path
 *     surfaces a clean "supplier not found" error,
 *   - the App-module wiring (BE-25 GA) overrides the
 *     `SUPPLIER_LOOKUP_TOKEN` provider so production reads hit the
 *     real `suppliers` table.
 *
 * `SupplierPerformanceStubService.updateMetrics` / `reverseMetrics`:
 *   - structured-log the payload so the metric stream is observable
 *     even before BE-25 is wired,
 *   - never throw — supplier metrics are best-effort, never block
 *     the GRN posting transaction.
 */

@Injectable()
export class SupplierLookupStubService implements ISupplierLookupService {
  constructor(private readonly logger: LoggerService) {}

  async findById(supplierId: string): Promise<SupplierLookupRow | null> {
    this.logger.warn('grn.supplier_lookup.stub_used', {
      reason: 'BE-25 suppliers module not yet wired — returning null',
      supplierId,
    });
    return null;
  }
}

@Injectable()
export class SupplierPerformanceStubService implements ISupplierPerformanceService {
  constructor(private readonly logger: LoggerService) {}

  async updateMetrics(_tenantId: string, supplierId: string, metrics: SupplierPerformanceMetrics): Promise<void> {
    this.logger.info('grn.supplier_performance.deferred.update', {
      reason: 'BE-25 supplier-performance service not yet wired',
      supplierId,
      grnId: metrics.grnId,
      deliveryDays: metrics.deliveryDays,
      expiryRemainingDays: metrics.expiryRemainingDays,
      shortShelfLife: metrics.shortShelfLife,
    });
  }

  async reverseMetrics(_tenantId: string, supplierId: string, grnId: string): Promise<void> {
    this.logger.info('grn.supplier_performance.deferred.reverse', {
      reason: 'BE-25 supplier-performance service not yet wired',
      supplierId,
      grnId,
    });
  }
}
