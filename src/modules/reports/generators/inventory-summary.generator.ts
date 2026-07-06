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
 * BE-20 — Inventory summary report.
 *
 * The `inventory_levels` and `inventory_movements` tables land in BE-27.
 * To keep BE-20 deployable in the meantime, this generator probes
 * `information_schema` and degrades gracefully when the inventory
 * tables aren't present yet, returning a zeroed summary with a
 * `notes` field so the API contract stays stable.
 */
@Injectable()
export class InventorySummaryGenerator implements IReportGenerator<Record<string, unknown>> {
  private readonly logger = new Logger(InventorySummaryGenerator.name);
  readonly type: ReportType = 'inventory-summary';

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
          AND table_name = 'inventory_levels'
      ) as exists
    `)) as unknown as { rows: Array<{ exists: boolean }> };

    if (!tableExists.rows?.[0]?.exists) {
      this.logger.warn(
        'inventory_levels table missing — returning empty inventory-summary report (BE-27 dependency)',
      );
      return {
        summary: {
          total: 0,
          inStock: 0,
          lowStock: 0,
          outOfStock: 0,
          notes: 'inventory tables are not present yet (BE-27 dependency)',
        },
        rows: [],
        meta: { deferred: 'BE-27' },
        generatedAt: new Date(),
      };
    }

    const storeIds = params.storeIds ?? [];
    const summaryRows = (await dbConn.execute<{
      total: number;
      in_stock: number;
      low_stock: number;
      out_of_stock: number;
    }>(sql`
      SELECT count(*)::int as total,
             sum(CASE WHEN quantity > reorder_point THEN 1 ELSE 0 END)::int as in_stock,
             sum(CASE WHEN quantity > 0 AND quantity <= reorder_point THEN 1 ELSE 0 END)::int as low_stock,
             sum(CASE WHEN quantity = 0 THEN 1 ELSE 0 END)::int as out_of_stock
      FROM inventory_levels
      WHERE tenant_id = ${tenantId}
        AND (${storeIds.length === 0} OR store_id = ANY(${storeIds}::uuid[]))
    `)) as unknown as {
      rows: Array<{
        total: number;
        in_stock: number;
        low_stock: number;
        out_of_stock: number;
      }>;
    };
    const r = summaryRows.rows?.[0];

    return {
      summary: {
        total: Number(r?.total ?? 0),
        inStock: Number(r?.in_stock ?? 0),
        lowStock: Number(r?.low_stock ?? 0),
        outOfStock: Number(r?.out_of_stock ?? 0),
      },
      rows: [],
      meta: {
        notes:
          'BE-20 ships an aggregate-only inventory summary; per-row breakdown lands when BE-27 GRN/inventory module activates.',
      },
      generatedAt: new Date(),
    };
  }
}
