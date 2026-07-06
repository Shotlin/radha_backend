import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';

import type {
  GenerateReportParams,
  HealthDistributionRow,
  IReportGenerator,
  ReportData,
  ReportType,
} from '../types/report.types';

interface RawDistributionRow extends Record<string, unknown> {
  grade: string;
  status: string;
  child_safety: string;
  count: number;
}

/**
 * BE-20 — Health-grade distribution across the tenant's catalog.
 *
 * Reads `product_health_assessments` (BE-12) joined with `products`
 * to count per-grade / per-child-safety bucket. Useful for owners
 * gauging the share of healthy / kid-safe stock in their stores.
 *
 * Note: assessments are global by design (rule_version-keyed), so
 * the tenant filter applies via the underlying product visibility
 * (private rows or global rows surfaced by tenant filter).
 */
@Injectable()
export class HealthDistributionGenerator implements IReportGenerator<HealthDistributionRow> {
  readonly type: ReportType = 'health-distribution';

  constructor(private readonly db: DbService) {}

  async generate(
    _params: GenerateReportParams,
    tenantId: string,
  ): Promise<ReportData<HealthDistributionRow>> {
    const dbConn = this.db.getDb();

    const result = (await dbConn.execute<RawDistributionRow>(sql`
      SELECT pha.overall_grade as grade,
             pha.health_status as status,
             pha.child_safety_status as child_safety,
             count(*)::int as count
      FROM product_health_assessments pha
      JOIN products p ON p.id = pha.product_id
      WHERE p.deleted_at IS NULL
        AND (p.tenant_id IS NULL OR p.tenant_id = ${tenantId})
      GROUP BY pha.overall_grade, pha.health_status, pha.child_safety_status
      ORDER BY pha.overall_grade ASC
    `)) as unknown as { rows: RawDistributionRow[] };

    const summary = {
      total: 0,
      byGrade: {} as Record<string, number>,
      byStatus: {} as Record<string, number>,
      byChildSafety: {} as Record<string, number>,
    };
    const data: HealthDistributionRow[] = [];

    for (const r of result.rows ?? []) {
      const count = Number(r.count);
      summary.total += count;
      summary.byGrade[r.grade] = (summary.byGrade[r.grade] ?? 0) + count;
      summary.byStatus[r.status] = (summary.byStatus[r.status] ?? 0) + count;
      summary.byChildSafety[r.child_safety] = (summary.byChildSafety[r.child_safety] ?? 0) + count;
      data.push({
        grade: r.grade,
        status: r.status,
        childSafety: r.child_safety,
        count,
      });
    }

    return {
      summary,
      rows: data,
      generatedAt: new Date(),
    };
  }
}
