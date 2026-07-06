import { Injectable } from '@nestjs/common';
import { and, avg, eq, max } from 'drizzle-orm';

import { DomainNotFoundException } from '@/common/errors/business.exception';
import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { type SupplierPerformanceRow, supplierPerformance } from '@/db/schema/suppliers';

import { SuppliersRepository } from '../repositories/suppliers.repository';
import type {
  PerformanceMetricInput,
  Supplier,
  SupplierPerformance,
} from '../types/supplier.types';

/**
 * BE-25 — Supplier performance metrics.
 *
 * Two responsibilities:
 *
 *   1. **Read aggregation** (`getPerformance`) — compute the
 *      reliability + quality scores from the
 *      `supplier_performance` ledger. Uses the denormalised
 *      counters on `suppliers` for the cheap totals so the response
 *      is one query for `O(1)` totals + one for the average expiry.
 *
 *   2. **Write recording** (`recordMetric`) — append a row to
 *      `supplier_performance` AND atomically refresh the denormalised
 *      counters on `suppliers`. Called by BE-26 GRN posting; until
 *      that's wired, the GRN-emit hook is a placeholder. The math is
 *      deterministic so it's safe to call multiple times for the
 *      same GRN (idempotency guarded by `(grn_id)` uniqueness in the
 *      caller — recommended once BE-26 ships).
 *
 * Scoring heuristics (placeholder until GRN data flows):
 *
 *   - reliabilityScore = 100 - round(shortShelfLife / totalGrns * 100)
 *     (clamped to [0, 100], default 50 when totalGrns = 0).
 *   - qualityScore     = supplier.qualityScore ?? 75 (manual-only
 *     until product-quality signals land in BE-29+).
 */
@Injectable()
export class SupplierPerformanceService {
  constructor(
    private readonly db: DbService,
    private readonly suppliersRepo: SuppliersRepository,
  ) {}

  /**
   * Build the performance view for a single supplier.
   *
   * `tenantId` is mandatory — never read by id alone, even though
   * the supplier_performance ledger is keyed by supplierId.
   */
  async getPerformance(tenantId: string, supplierId: string): Promise<SupplierPerformance> {
    const supplier = await this.suppliersRepo.findByIdInTenant(supplierId, tenantId);
    if (!supplier) throw new DomainNotFoundException('Supplier', supplierId);

    const [agg] = (await this.db
      .getDb()
      .select({
        avgExpiry: avg(supplierPerformance.expiryRemainingDays),
        latest: max(supplierPerformance.recordedAt),
      })
      .from(supplierPerformance)
      .where(
        and(
          eq(supplierPerformance.supplierId, supplierId),
          eq(supplierPerformance.tenantId, tenantId),
        ),
      )) as Array<{ avgExpiry: string | null; latest: Date | null }>;

    return this.compose(supplier, {
      avgExpiry: this.toNumber(agg?.avgExpiry, 0),
      latestFromLedger: agg?.latest ?? null,
    });
  }

  /**
   * Insert a per-GRN snapshot AND refresh the denormalised counters
   * in one transaction. Returns the persisted ledger row.
   *
   * Until BE-26 GRN posting wires this in, the method is callable
   * via an admin tool to backfill historic data. The fields on
   * `metric` mirror what the GRN posting service knows at the
   * moment it transitions a GRN to `posted`.
   */
  async recordMetric(
    tenantId: string,
    supplierId: string,
    metric: PerformanceMetricInput,
    tx?: Transaction,
  ): Promise<SupplierPerformanceRow> {
    const work = async (innerTx: Transaction): Promise<SupplierPerformanceRow> => {
      const supplier = await this.suppliersRepo.findByIdInTenant(supplierId, tenantId);
      if (!supplier) throw new DomainNotFoundException('Supplier', supplierId);

      const [inserted] = (await innerTx
        .insert(supplierPerformance)
        .values({
          supplierId,
          tenantId,
          grnId: metric.grnId,
          deliveryDays: Math.max(0, Math.floor(metric.deliveryDays)),
          expiryRemainingDays:
            metric.expiryRemainingDays === undefined
              ? null
              : Math.max(0, Math.floor(metric.expiryRemainingDays)),
          shortShelfLife: metric.shortShelfLife,
          amount: metric.amount?.toFixed(2),
          metadata: metric.metadata ?? {},
        })
        .returning()) as SupplierPerformanceRow[];

      const newTotal = supplier.totalGrns + 1;
      const oldAvg = this.toNumber(supplier.averageDeliveryDays, 0);
      const newAvg = (oldAvg * supplier.totalGrns + Math.max(0, metric.deliveryDays)) / newTotal;

      const newShortCount = supplier.shortShelfLifeIncidents + (metric.shortShelfLife ? 1 : 0);
      const reliability = this.computeReliabilityScore(newShortCount, newTotal);

      await this.suppliersRepo.refreshPerformanceCounters(
        supplierId,
        {
          totalGrns: 1,
          shortShelfLifeIncidents: metric.shortShelfLife ? 1 : 0,
          totalAmountDelivered: metric.amount ?? 0,
          averageDeliveryDays: newAvg,
          reliabilityScore: reliability,
          lastDeliveryDate: new Date(),
        },
        innerTx,
      );

      return inserted;
    };

    if (tx) return work(tx);
    return this.db.transaction(work);
  }

  /**
   * Pure helper: build the wire shape from a Supplier row + computed
   * aggregates. Exposed so the import service / list endpoint can
   * reuse it without re-querying the ledger.
   */
  compose(
    supplier: Supplier,
    aggregates: { avgExpiry: number; latestFromLedger: Date | null },
  ): SupplierPerformance {
    const totalGrns = supplier.totalGrns;
    const reliabilityScore =
      supplier.reliabilityScore ??
      this.computeReliabilityScore(supplier.shortShelfLifeIncidents, totalGrns);

    return {
      supplierId: supplier.id,
      totalGrns,
      averageDeliveryDays: this.toNumber(supplier.averageDeliveryDays, 0),
      avgExpiryRemainingDays: aggregates.avgExpiry,
      shortShelfLifeIncidents: supplier.shortShelfLifeIncidents,
      qualityScore: supplier.qualityScore ?? 75,
      reliabilityScore,
      lastDeliveryDate: supplier.lastDeliveryDate ?? aggregates.latestFromLedger,
      totalAmountDelivered: this.toNumber(supplier.totalAmountDelivered, 0),
    };
  }

  /**
   * Heuristic: every short-shelf-life incident knocks 1 point off
   * the perfect 100. Returns 50 (neutral) when no GRNs have been
   * posted so the UI doesn't render a misleading "0 / 100".
   */
  computeReliabilityScore(shortShelf: number, totalGrns: number): number {
    if (totalGrns <= 0) return 50;
    const penalty = Math.round((shortShelf / totalGrns) * 100);
    return Math.max(0, Math.min(100, 100 - penalty));
  }

  private toNumber(value: unknown, fallback: number): number {
    if (value === null || value === undefined) return fallback;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
}
