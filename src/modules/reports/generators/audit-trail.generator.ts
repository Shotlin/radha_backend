import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';

import type {
  AuditTrailRow,
  GenerateReportParams,
  IReportGenerator,
  ReportData,
  ReportType,
} from '../types/report.types';

const MAX_ROWS = 50_000;

interface RawAuditRow extends Record<string, unknown> {
  audit_log_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  user_id: string | null;
  occurred_at: Date;
  success: boolean;
  error_code: string | null;
}

/**
 * BE-20 — Audit-trail report.
 *
 * Mirrors `audit_logs` rows for compliance review. Tenant-scoped so
 * cross-tenant data is never visible. Free Consumer / Staff cannot
 * generate this — the controller restricts to Owner / Auditor / Admin.
 */
@Injectable()
export class AuditTrailGenerator implements IReportGenerator<AuditTrailRow> {
  readonly type: ReportType = 'audit-trail';

  constructor(private readonly db: DbService) {}

  async generate(
    params: GenerateReportParams,
    tenantId: string,
  ): Promise<ReportData<AuditTrailRow>> {
    const dbConn = this.db.getDb();

    const counters = (await dbConn.execute<{ action: string; count: number }>(sql`
      SELECT action, count(*)::int as count
      FROM audit_logs
      WHERE tenant_id = ${tenantId}
        AND occurred_at >= ${params.dateRange.from}
        AND occurred_at <= ${params.dateRange.to}
      GROUP BY action
    `)) as unknown as { rows: Array<{ action: string; count: number }> };

    const rowsResult = (await dbConn.execute<RawAuditRow>(sql`
      SELECT id as audit_log_id,
             action,
             resource_type,
             resource_id,
             user_id,
             occurred_at,
             success,
             error_code
      FROM audit_logs
      WHERE tenant_id = ${tenantId}
        AND occurred_at >= ${params.dateRange.from}
        AND occurred_at <= ${params.dateRange.to}
      ORDER BY occurred_at DESC
      LIMIT ${MAX_ROWS}
    `)) as unknown as { rows: RawAuditRow[] };

    const byAction: Record<string, number> = {};
    let total = 0;
    for (const r of counters.rows ?? []) {
      const count = Number(r.count);
      byAction[r.action] = count;
      total += count;
    }

    const data = (rowsResult.rows ?? []).map((r) => ({
      auditLogId: r.audit_log_id,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      userId: r.user_id,
      occurredAt: r.occurred_at,
      success: r.success,
      errorCode: r.error_code,
    }));

    return {
      summary: { total, byAction },
      rows: data,
      meta: { truncated: data.length >= MAX_ROWS, maxRows: MAX_ROWS },
      generatedAt: new Date(),
    };
  }
}
