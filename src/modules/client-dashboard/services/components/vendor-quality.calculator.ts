import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';

import type {
  ComponentInput,
  ComponentResult,
  IComponentCalculator,
  OhsComponentName,
} from '../../types/dashboard.types';
import { rowAt, toNumber } from '../sql-result.utils';

/**
 * BE-30 v2 — Vendor quality component (10 % of OHS).
 *
 * Score = `avg(quality_score) / 100`, averaged across the tenant's
 * suppliers (not store-scoped — supplier records are tenant-level).
 *
 * `suppliers.quality_score` is a 0..100 integer maintained by
 * BE-25's `SupplierPerformanceService`. We treat NULL as "no data
 * yet" and exclude those rows from the average; if every supplier
 * is NULL or the tenant has no suppliers, we score 1.0 (zero-data
 * fallback).
 */
@Injectable()
export class VendorQualityCalculator implements IComponentCalculator {
  readonly name: OhsComponentName = 'vendorQuality';
  readonly weight = 0.1;

  constructor(private readonly db: DbService) {}

  async compute(input: ComponentInput): Promise<ComponentResult> {
    const conn = this.db.getDb();

    type Row = {
      avg_quality: number | string | null;
      rated_suppliers: number | string | null;
      total_suppliers: number | string | null;
    };

    const result = await conn.execute<Row>(sql`
      SELECT
        avg(quality_score)::float                                         AS avg_quality,
        count(*) FILTER (WHERE quality_score IS NOT NULL)::int            AS rated_suppliers,
        count(*)::int                                                      AS total_suppliers
      FROM suppliers
      WHERE tenant_id = ${input.tenantId}
        AND deleted_at IS NULL
        AND status IN ('active','inactive')
    `);

    const row = (rowAt<Row>(result, 0) ?? ({} as Row)) as Row;
    const avgQuality = toNumber(row.avg_quality);
    const rated = toNumber(row.rated_suppliers);
    const total = toNumber(row.total_suppliers);

    const rawScore = rated > 0 ? clamp01(avgQuality / 100) : 1;

    return {
      rawScore,
      rawInputs: {
        ratedSuppliers: rated,
        totalSuppliers: total,
        averageQuality: avgQuality,
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
