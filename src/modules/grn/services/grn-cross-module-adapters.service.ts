import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import { SuppliersRepository } from '@/modules/suppliers/repositories/suppliers.repository';
import { SupplierPerformanceService } from '@/modules/suppliers/services/supplier-performance.service';

import type {
  ISupplierLookupService,
  ISupplierPerformanceService,
  SupplierLookupRow,
  SupplierPerformanceMetrics,
} from '../types/grn.types';

/**
 * BE-26 ↔ BE-25 adapters.
 *
 * The GRN module defines narrow ports (`ISupplierLookupService`,
 * `ISupplierPerformanceService`) so it doesn't take a hard compile-
 * time dependency on the full `SuppliersModule` surface. These
 * adapters bridge the ports to the real BE-25 implementations now
 * that both modules are in the same build.
 *
 * Previously the ports were wired to in-process stubs that returned
 * `null` / logged and no-oped — meaning every `createDraft` call
 * threw 404 (supplier not found) and posted GRNs never recorded
 * performance metrics. These adapters close both gaps.
 */

@Injectable()
export class GrnSupplierLookupAdapterService implements ISupplierLookupService {
  constructor(private readonly suppliersRepo: SuppliersRepository) {}

  /**
   * Non-tenant-scoped read — the GRN service verifies tenant
   * ownership itself (`supplier.tenantId !== tenantId → 404`) so the
   * lookup intentionally skips the tenant filter here.
   */
  async findById(supplierId: string): Promise<SupplierLookupRow | null> {
    const row = await this.suppliersRepo.findById(supplierId);
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      status: row.status as SupplierLookupRow['status'],
    };
  }
}

@Injectable()
export class GrnSupplierPerfAdapterService implements ISupplierPerformanceService {
  constructor(
    private readonly perfService: SupplierPerformanceService,
    private readonly logger: LoggerService,
  ) {}

  async updateMetrics(
    tenantId: string,
    supplierId: string,
    metrics: SupplierPerformanceMetrics,
  ): Promise<void> {
    try {
      await this.perfService.recordMetric(tenantId, supplierId, {
        grnId: metrics.grnId,
        deliveryDays: metrics.deliveryDays,
        expiryRemainingDays: metrics.expiryRemainingDays,
        shortShelfLife: metrics.shortShelfLife,
        amount: metrics.amount,
        // `postedAt` is GRN-specific context; PerformanceMetricInput does not carry it.
      });
    } catch (err) {
      this.logger.warn('grn.supplier_performance.update_failed', {
        tenantId,
        supplierId,
        grnId: metrics.grnId,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
    }
  }

  async reverseMetrics(tenantId: string, supplierId: string, grnId: string): Promise<void> {
    this.logger.info('grn.supplier_performance.reverse_deferred', {
      reason: 'SupplierPerformanceService has no reversal method — metrics are append-only',
      tenantId,
      supplierId,
      grnId,
    });
  }
}
