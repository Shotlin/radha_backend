import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';

import type {
  EanMismatchRow,
  GenerateReportParams,
  IReportGenerator,
  ReportData,
  ReportType,
} from '../types/report.types';

const MAX_ROWS = 10_000;

interface RawCounter extends Record<string, unknown> {
  status: string;
  count: number;
}

interface RawMismatchRow extends Record<string, unknown> {
  scan_item_id: string;
  session_id: string;
  store_id: string;
  store_name: string | null;
  user_id: string;
  user_name: string | null;
  ean: string;
  product_id: string | null;
  product_name: string | null;
  scanned_at: Date;
  match_status: string;
  ean_list_id: string | null;
}

/**
 * BE-20 — EAN mismatch report.
 *
 * Lists scans whose EAN match status is `unmatched` or `invalid`,
 * joined with the user / store / session context so an Owner can hold
 * either staff or vendors accountable. Adds a `matched` row to the
 * summary so consumers can render a match-rate percentage.
 */
@Injectable()
export class EanMismatchGenerator implements IReportGenerator<EanMismatchRow> {
  readonly type: ReportType = 'ean-mismatch';

  constructor(private readonly db: DbService) {}

  async generate(
    params: GenerateReportParams,
    tenantId: string,
  ): Promise<ReportData<EanMismatchRow>> {
    const dbConn = this.db.getDb();
    const storeIds = params.storeIds ?? [];

    const counters = (await dbConn.execute<RawCounter>(sql`
      SELECT si.ean_match_status as status, count(*)::int as count
      FROM scan_items si
      WHERE si.tenant_id = ${tenantId}
        AND si.deleted_at IS NULL
        AND (${storeIds.length === 0} OR si.store_id = ANY(${storeIds}::uuid[]))
        AND si.scanned_at >= ${params.dateRange.from}
        AND si.scanned_at <= ${params.dateRange.to}
      GROUP BY si.ean_match_status
    `)) as unknown as { rows: RawCounter[] };

    const rowsResult = (await dbConn.execute<RawMismatchRow>(sql`
      SELECT si.id as scan_item_id,
             si.session_id,
             si.store_id,
             s.name as store_name,
             si.user_id,
             u.name as user_name,
             si.ean,
             si.product_id,
             COALESCE(p.name, si.product_name_snapshot) as product_name,
             si.scanned_at,
             si.ean_match_status as match_status,
             ses.ean_list_id
      FROM scan_items si
      LEFT JOIN scan_sessions ses ON ses.id = si.session_id
      LEFT JOIN products p ON p.id = si.product_id
      LEFT JOIN stores s ON s.id = si.store_id
      LEFT JOIN users u ON u.id = si.user_id
      WHERE si.tenant_id = ${tenantId}
        AND si.deleted_at IS NULL
        AND si.ean_match_status IN ('unmatched', 'invalid')
        AND (${storeIds.length === 0} OR si.store_id = ANY(${storeIds}::uuid[]))
        AND si.scanned_at >= ${params.dateRange.from}
        AND si.scanned_at <= ${params.dateRange.to}
      ORDER BY si.scanned_at DESC
      LIMIT ${MAX_ROWS}
    `)) as unknown as { rows: RawMismatchRow[] };

    return {
      summary: this.buildSummary(counters.rows ?? []),
      rows: (rowsResult.rows ?? []).map((r) => ({
        scanItemId: r.scan_item_id,
        sessionId: r.session_id,
        storeId: r.store_id,
        storeName: r.store_name,
        userId: r.user_id,
        userName: r.user_name,
        ean: r.ean,
        productId: r.product_id,
        productName: r.product_name,
        scannedAt: r.scanned_at,
        matchStatus: r.match_status,
        eanListId: r.ean_list_id,
      })),
      meta: {
        truncated: (rowsResult.rows ?? []).length >= MAX_ROWS,
        maxRows: MAX_ROWS,
      },
      generatedAt: new Date(),
    };
  }

  private buildSummary(rows: RawCounter[]): Record<string, unknown> {
    const result = {
      total: 0,
      matched: 0,
      unmatched: 0,
      invalid: 0,
      noList: 0,
      unchecked: 0,
      matchRate: 0,
    };
    for (const r of rows) {
      const count = Number(r.count);
      result.total += count;
      switch (r.status) {
        case 'matched':
          result.matched = count;
          break;
        case 'unmatched':
          result.unmatched = count;
          break;
        case 'invalid':
          result.invalid = count;
          break;
        case 'no_list':
          result.noList = count;
          break;
        case 'unchecked':
          result.unchecked = count;
          break;
        default:
          break;
      }
    }
    result.matchRate =
      result.total > 0 ? Math.round((result.matched / result.total) * 1000) / 10 : 0;
    return result;
  }
}
