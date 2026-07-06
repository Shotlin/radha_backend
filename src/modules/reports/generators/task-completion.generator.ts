import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';

import type {
  GenerateReportParams,
  IReportGenerator,
  ReportData,
  ReportType,
  TaskCompletionRow,
} from '../types/report.types';

const MAX_ROWS = 10_000;

/**
 * BE-20 — Task completion report.
 *
 * The `tasks` table itself lands in BE-19. To keep BE-20 deployable
 * ahead of BE-19 the generator probes the table at runtime and
 * gracefully returns an empty result with a clear `notes` summary
 * when the table is missing. Once BE-19 ships, no code change is
 * needed — the generator starts returning rows automatically.
 */
@Injectable()
export class TaskCompletionGenerator implements IReportGenerator<TaskCompletionRow> {
  private readonly logger = new Logger(TaskCompletionGenerator.name);
  readonly type: ReportType = 'task-completion';

  constructor(private readonly db: DbService) {}

  async generate(
    params: GenerateReportParams,
    tenantId: string,
  ): Promise<ReportData<TaskCompletionRow>> {
    const dbConn = this.db.getDb();

    const tableExists = (await dbConn.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'tasks'
      ) as exists
    `)) as unknown as { rows: Array<{ exists: boolean }> };

    if (!tableExists.rows?.[0]?.exists) {
      this.logger.warn(
        'tasks table not present yet — returning empty task-completion report (BE-19 dependency)',
      );
      return {
        summary: {
          total: 0,
          completed: 0,
          overdue: 0,
          completionRate: 0,
          notes: 'tasks table is not present yet (BE-19 dependency)',
        },
        rows: [],
        meta: { deferred: 'BE-19' },
        generatedAt: new Date(),
      };
    }

    const storeIds = params.storeIds ?? [];

    const counters = (await dbConn.execute<{ status: string; count: number }>(sql`
      SELECT status, count(*)::int as count
      FROM tasks
      WHERE tenant_id = ${tenantId}
        AND (${storeIds.length === 0} OR store_id = ANY(${storeIds}::uuid[]))
        AND created_at >= ${params.dateRange.from}
        AND created_at <= ${params.dateRange.to}
      GROUP BY status
    `)) as unknown as { rows: Array<{ status: string; count: number }> };

    const rowsResult = (await dbConn.execute<{
      task_id: string;
      title: string;
      status: string;
      assigned_to: string | null;
      assigned_by: string | null;
      store_id: string | null;
      created_at: Date;
      due_at: Date | null;
      completed_at: Date | null;
      duration_minutes: number | null;
    }>(sql`
      SELECT id as task_id,
             title,
             status,
             assigned_to,
             assigned_by,
             store_id,
             created_at,
             due_at,
             completed_at,
             CASE
               WHEN completed_at IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (completed_at - created_at))::int / 60
               ELSE NULL
             END as duration_minutes
      FROM tasks
      WHERE tenant_id = ${tenantId}
        AND (${storeIds.length === 0} OR store_id = ANY(${storeIds}::uuid[]))
        AND created_at >= ${params.dateRange.from}
        AND created_at <= ${params.dateRange.to}
      ORDER BY created_at DESC
      LIMIT ${MAX_ROWS}
    `)) as unknown as {
      rows: Array<{
        task_id: string;
        title: string;
        status: string;
        assigned_to: string | null;
        assigned_by: string | null;
        store_id: string | null;
        created_at: Date;
        due_at: Date | null;
        completed_at: Date | null;
        duration_minutes: number | null;
      }>;
    };

    const summary = {
      total: 0,
      completed: 0,
      overdue: 0,
      pending: 0,
      cancelled: 0,
      completionRate: 0,
    };
    for (const r of counters.rows ?? []) {
      const count = Number(r.count);
      summary.total += count;
      if (r.status === 'completed') summary.completed = count;
      else if (r.status === 'overdue') summary.overdue = count;
      else if (r.status === 'pending') summary.pending = count;
      else if (r.status === 'cancelled') summary.cancelled = count;
    }
    summary.completionRate =
      summary.total > 0 ? Math.round((summary.completed / summary.total) * 1000) / 10 : 0;

    const data = (rowsResult.rows ?? []).map((r) => ({
      taskId: r.task_id,
      title: r.title,
      status: r.status,
      assignedTo: r.assigned_to,
      assignedBy: r.assigned_by,
      storeId: r.store_id,
      createdAt: r.created_at,
      dueAt: r.due_at,
      completedAt: r.completed_at,
      durationMinutes: r.duration_minutes === null ? null : Number(r.duration_minutes),
    }));

    return {
      summary,
      rows: data,
      meta: { truncated: data.length >= MAX_ROWS, maxRows: MAX_ROWS },
      generatedAt: new Date(),
    };
  }
}
