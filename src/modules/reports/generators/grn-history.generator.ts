import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';

import type {
  GenerateReportParams,
  IReportGenerator,
  ReportData,
  ReportType,
} from '../types/report.types';

/**
 * BE-20 — GRN (goods-received-note) history report.
 *
 * The `grn_headers` and `grn_lines` tables ship in BE-26. This
 * generator probes `information_schema` and gracefully returns a
 * zeroed summary when the tables aren't present yet, so the BE-20
 * API contract is stable and the BE-26 phase only has to fill in the
 * SQL when the schema arrives.
 */
@Injectable()
export class GrnHistoryGenerator implements IReportGenerator<Record<string, unknown>> {
  private readonly logger = new Logger(GrnHistoryGenerator.name);
  readonly type: ReportType = 'grn-history';

  constructor(private readonly db: DbService) {}

  async generate(
    params: GenerateReportParams,
    tenantId: string,
  ): Promise<ReportData<Record<string, unknown>>> {
    const dbConn = this.db.getDb();
    const tableExists = (await dbConn.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'grn_headers'
      ) as exists
    `)) as unknown as { rows: Array<{ exists: boolean }> };

    if (!tableExists.rows?.[0]?.exists) {
      this.logger.warn(
        'grn_headers table missing — returning empty grn-history report (BE-26 dependency)',
      );
      return {
        summary: {
          total: 0,
          posted: 0,
          cancelled: 0,
          notes: 'grn tables are not present yet (BE-26 dependency)',
        },
        rows: [],
        meta: { deferred: 'BE-26' },
        generatedAt: new Date(),
      };
    }

    const storeIds = params.storeIds ?? [];
    const counters = (await dbConn.execute<{ status: string; count: number }>(sql`
      SELECT status, count(*)::int as count
      FROM grn_headers
      WHERE tenant_id = ${tenantId}
        AND (${storeIds.length === 0} OR store_id = ANY(${storeIds}::uuid[]))
        AND received_at >= ${params.dateRange.from}
        AND received_at <= ${params.dateRange.to}
      GROUP BY status
    `)) as unknown as { rows: Array<{ status: string; count: number }> };

    const summary = {
      total: 0,
      posted: 0,
      cancelled: 0,
      pending: 0,
    };
    for (const r of counters.rows ?? []) {
      const count = Number(r.count);
      summary.total += count;
      if (r.status in summary) {
        (summary as Record<string, number>)[r.status] = count;
      }
    }

    return {
      summary,
      rows: [],
      meta: {
        notes: 'BE-20 ships an aggregate-only GRN summary; per-line breakdown lands with BE-26.',
      },
      generatedAt: new Date(),
    };
  }
}
