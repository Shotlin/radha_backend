import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';

import type {
  ExpirySummaryRow,
  GenerateReportParams,
  IReportGenerator,
  ReportData,
  ReportType,
} from '../types/report.types';

const MAX_ROWS = 10_000;

interface RawSummaryRow extends Record<string, unknown> {
  status: string;
  count: number;
  total_quantity: number;
}

interface RawExpiryRow extends Record<string, unknown> {
  expiry_record_id: string;
  product_id: string;
  product_name: string;
  brand: string | null;
  ean: string;
  category: string | null;
  store_id: string;
  store_name: string | null;
  expiry_date: Date;
  days_remaining: number | null;
  status: string;
  quantity: number;
  remaining_quantity: number;
  batch_number: string | null;
}

/**
 * BE-20 — Expiry summary report.
 *
 * Joins `expiry_records` against `products` and `stores` to produce a
 * shelf-life snapshot for one or more stores in a given window. The
 * `summary` block carries red/yellow/green totals so list views can
 * render without re-running the query.
 *
 * Returns at most `MAX_ROWS` rows; callers needing more should refine
 * the date range or the storeIds filter.
 */
@Injectable()
export class ExpirySummaryGenerator implements IReportGenerator<ExpirySummaryRow> {
  readonly type: ReportType = 'expiry-summary';

  constructor(private readonly db: DbService) {}

  async generate(
    params: GenerateReportParams,
    tenantId: string,
  ): Promise<ReportData<ExpirySummaryRow>> {
    const dbConn = this.db.getDb();
    const storeIds = params.storeIds ?? [];

    const summary = (await dbConn.execute<RawSummaryRow>(sql`
      SELECT er.status as status,
             count(*)::int as count,
             coalesce(sum(er.quantity), 0)::int as total_quantity
      FROM expiry_records er
      WHERE er.tenant_id = ${tenantId}
        AND er.deleted_at IS NULL
        AND (${storeIds.length === 0} OR er.store_id = ANY(${storeIds}::uuid[]))
        AND er.expiry_date >= ${params.dateRange.from}
        AND er.expiry_date <= ${params.dateRange.to}
      GROUP BY er.status
    `)) as unknown as { rows: RawSummaryRow[] };

    const rowsResult = (await dbConn.execute<RawExpiryRow>(sql`
      SELECT er.id as expiry_record_id,
             er.product_id,
             p.name as product_name,
             p.brand,
             p.ean,
             p.sub_category as category,
             er.store_id,
             s.name as store_name,
             er.expiry_date,
             er.days_remaining,
             er.status,
             er.quantity,
             er.remaining_quantity,
             er.batch_number
      FROM expiry_records er
      JOIN products p ON p.id = er.product_id
      LEFT JOIN stores s ON s.id = er.store_id
      WHERE er.tenant_id = ${tenantId}
        AND er.deleted_at IS NULL
        AND (${storeIds.length === 0} OR er.store_id = ANY(${storeIds}::uuid[]))
        AND er.expiry_date >= ${params.dateRange.from}
        AND er.expiry_date <= ${params.dateRange.to}
      ORDER BY er.expiry_date ASC
      LIMIT ${MAX_ROWS}
    `)) as unknown as { rows: RawExpiryRow[] };

    return {
      summary: this.buildSummary(summary.rows ?? []),
      rows: (rowsResult.rows ?? []).map((r) => ({
        expiryRecordId: r.expiry_record_id,
        productId: r.product_id,
        productName: r.product_name,
        brand: r.brand,
        ean: r.ean,
        category: r.category,
        storeId: r.store_id,
        storeName: r.store_name,
        expiryDate: r.expiry_date,
        daysRemaining: r.days_remaining === null ? null : Number(r.days_remaining),
        status: r.status,
        quantity: Number(r.quantity),
        remainingQuantity: Number(r.remaining_quantity),
        batchNumber: r.batch_number,
      })),
      meta: {
        truncated: (rowsResult.rows ?? []).length >= MAX_ROWS,
        maxRows: MAX_ROWS,
      },
      generatedAt: new Date(),
    };
  }

  private buildSummary(rows: RawSummaryRow[]): Record<string, unknown> {
    const result = {
      total: 0,
      green: 0,
      yellow: 0,
      red: 0,
      expired: 0,
      unknown: 0,
      totalQuantity: 0,
    };
    for (const row of rows) {
      const count = Number(row.count);
      result.total += count;
      result.totalQuantity += Number(row.total_quantity);
      if (row.status in result) {
        (result as Record<string, number>)[row.status] = count;
      }
    }
    return result;
  }
}
