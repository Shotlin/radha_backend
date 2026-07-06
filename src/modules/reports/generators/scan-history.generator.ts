import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';

import type {
  GenerateReportParams,
  IReportGenerator,
  ReportData,
  ReportType,
  ScanHistoryRow,
} from '../types/report.types';

const MAX_ROWS = 50_000;

interface RawScanRow extends Record<string, unknown> {
  scan_item_id: string;
  session_id: string;
  store_id: string;
  store_name: string | null;
  user_id: string;
  user_name: string | null;
  ean: string;
  product_id: string | null;
  product_name: string | null;
  match_status: string;
  expiry_status: string;
  scanned_at: Date;
}

/**
 * BE-20 — Full scan history report. Larger row cap (50K) than other
 * generators because audit data is the prime use-case. Date-range
 * caps in the DTO (365 days max) keep the worst case bounded at
 * roughly one busy retail year.
 */
@Injectable()
export class ScanHistoryGenerator implements IReportGenerator<ScanHistoryRow> {
  readonly type: ReportType = 'scan-history';

  constructor(private readonly db: DbService) {}

  async generate(
    params: GenerateReportParams,
    tenantId: string,
  ): Promise<ReportData<ScanHistoryRow>> {
    const dbConn = this.db.getDb();
    const storeIds = params.storeIds ?? [];

    const totals = (await dbConn.execute<{
      total: number;
      sessions: number;
      unique_users: number;
      unique_eans: number;
    }>(sql`
      SELECT count(*)::int as total,
             count(DISTINCT si.session_id)::int as sessions,
             count(DISTINCT si.user_id)::int as unique_users,
             count(DISTINCT si.ean)::int as unique_eans
      FROM scan_items si
      WHERE si.tenant_id = ${tenantId}
        AND si.deleted_at IS NULL
        AND (${storeIds.length === 0} OR si.store_id = ANY(${storeIds}::uuid[]))
        AND si.scanned_at >= ${params.dateRange.from}
        AND si.scanned_at <= ${params.dateRange.to}
    `)) as unknown as {
      rows: Array<{
        total: number;
        sessions: number;
        unique_users: number;
        unique_eans: number;
      }>;
    };

    const rowsResult = (await dbConn.execute<RawScanRow>(sql`
      SELECT si.id as scan_item_id,
             si.session_id,
             si.store_id,
             s.name as store_name,
             si.user_id,
             u.name as user_name,
             si.ean,
             si.product_id,
             COALESCE(p.name, si.product_name_snapshot) as product_name,
             si.ean_match_status as match_status,
             si.expiry_status,
             si.scanned_at
      FROM scan_items si
      LEFT JOIN products p ON p.id = si.product_id
      LEFT JOIN stores s ON s.id = si.store_id
      LEFT JOIN users u ON u.id = si.user_id
      WHERE si.tenant_id = ${tenantId}
        AND si.deleted_at IS NULL
        AND (${storeIds.length === 0} OR si.store_id = ANY(${storeIds}::uuid[]))
        AND si.scanned_at >= ${params.dateRange.from}
        AND si.scanned_at <= ${params.dateRange.to}
      ORDER BY si.scanned_at DESC
      LIMIT ${MAX_ROWS}
    `)) as unknown as { rows: RawScanRow[] };

    const totalRow = totals.rows?.[0];
    const data = (rowsResult.rows ?? []).map((r) => ({
      scanItemId: r.scan_item_id,
      sessionId: r.session_id,
      storeId: r.store_id,
      storeName: r.store_name,
      userId: r.user_id,
      userName: r.user_name,
      ean: r.ean,
      productId: r.product_id,
      productName: r.product_name,
      matchStatus: r.match_status,
      expiryStatus: r.expiry_status,
      scannedAt: r.scanned_at,
    }));

    return {
      summary: {
        totalScans: Number(totalRow?.total ?? 0),
        sessions: Number(totalRow?.sessions ?? 0),
        uniqueUsers: Number(totalRow?.unique_users ?? 0),
        uniqueEans: Number(totalRow?.unique_eans ?? 0),
      },
      rows: data,
      meta: { truncated: data.length >= MAX_ROWS, maxRows: MAX_ROWS },
      generatedAt: new Date(),
    };
  }
}
