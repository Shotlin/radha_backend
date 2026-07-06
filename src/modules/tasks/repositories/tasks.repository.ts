import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewTask, TaskRow, tasks } from '@/db/schema/tasks';

import type {
  AssigneeStat,
  TaskFilters,
  TaskPriority,
  TaskStats,
  TaskStatus,
  TaskType,
} from '../types/task.types';

/**
 * BE-19 — `tasks` table data access.
 *
 * Wraps `BaseRepository` for CRUD + adds:
 *   - `findByIdInTenant`   (mandatory pattern across BE-15+)
 *   - `listForTenant`      (filtered, single index-friendly query)
 *   - `listForAssignee`    (joins assignment table)
 *   - `findOverdueCandidates`  (BE-24 cron sweep)
 *   - `getStats`           (single aggregate query)
 *   - `incrementCounter`   (atomic SQL increments for evidenceCount /
 *                           assigneeCount / recurrenceOccurrenceCount)
 */
@Injectable()
export class TasksRepository extends BaseRepository<
  typeof tasks,
  TaskRow,
  NewTask,
  Partial<NewTask>
> {
  constructor(db: DbService) {
    super(db.getDb(), tasks, 'tasks');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<TaskRow | null> {
    const [row] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId), isNull(tasks.deletedAt)))
      .limit(1);
    return (row as TaskRow | undefined) ?? null;
  }

  async findByExpiryAlert(tenantId: string, alertId: string): Promise<TaskRow | null> {
    const [row] = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, tenantId),
          eq(tasks.expiryAlertId, alertId),
          isNull(tasks.deletedAt),
        ),
      )
      .limit(1);
    return (row as TaskRow | undefined) ?? null;
  }

  async listForTenant(tenantId: string, filters: TaskFilters): Promise<TaskRow[]> {
    const conditions = [eq(tasks.tenantId, tenantId)];
    if (!filters.includeDeleted) conditions.push(isNull(tasks.deletedAt));
    if (filters.storeId) conditions.push(eq(tasks.storeId, filters.storeId));
    if (filters.status?.length) conditions.push(inArray(tasks.status, filters.status));
    if (filters.priority?.length) conditions.push(inArray(tasks.priority, filters.priority));
    if (filters.type?.length) conditions.push(inArray(tasks.type, filters.type));
    if (filters.dueBefore) conditions.push(lte(tasks.dueDate, filters.dueBefore));
    if (filters.dueAfter) conditions.push(gte(tasks.dueDate, filters.dueAfter));
    if (filters.templateId) conditions.push(eq(tasks.templateId, filters.templateId));
    if (filters.parentTaskId) conditions.push(eq(tasks.parentTaskId, filters.parentTaskId));
    if (filters.expiryAlertId) conditions.push(eq(tasks.expiryAlertId, filters.expiryAlertId));

    return (await this.db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(desc(tasks.priority), asc(tasks.dueDate), desc(tasks.createdAt))
      .limit(filters.limit ?? 50)) as TaskRow[];
  }

  /**
   * Find candidates whose dueDate has passed but status is still
   * `pending` or `in_progress` — used by `BE-24` overdue sweep.
   */
  async findOverdueCandidates(now: Date, limit: number): Promise<TaskRow[]> {
    return (await this.db
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.status, ['pending', 'in_progress']),
          isNotNull(tasks.dueDate),
          lt(tasks.dueDate, now),
          isNull(tasks.deletedAt),
        ),
      )
      .orderBy(asc(tasks.dueDate))
      .limit(limit)) as TaskRow[];
  }

  async markOverdue(id: string, now: Date, tx?: Transaction): Promise<void> {
    const scope = tx ?? this.db;
    await scope
      .update(tasks)
      .set({ status: 'overdue', overdueMarkedAt: now, updatedAt: now })
      .where(and(eq(tasks.id, id), inArray(tasks.status, ['pending', 'in_progress'])));
  }

  /**
   * Atomic counter delta. `column` is restricted to known integer
   * fields so callers can't bump a non-numeric column.
   */
  async incrementCounter(
    id: string,
    column: 'evidenceCount' | 'assigneeCount' | 'recurrenceOccurrenceCount',
    delta: number,
    tx?: Transaction,
  ): Promise<void> {
    const scope = tx ?? this.db;
    const map = {
      evidenceCount: tasks.evidenceCount,
      assigneeCount: tasks.assigneeCount,
      recurrenceOccurrenceCount: tasks.recurrenceOccurrenceCount,
    } as const;
    const col = map[column];
    await scope
      .update(tasks)
      .set({ [column]: sql`${col} + ${delta}`, updatedAt: new Date() })
      .where(eq(tasks.id, id));
  }

  /**
   * Aggregated stats for a tenant (optionally store-scoped). One
   * GROUP BY query per dimension; the small number of distinct
   * status/priority/type values means each is cheap.
   */
  async getStats(tenantId: string, storeId: string | null): Promise<TaskStats> {
    const baseConds = [eq(tasks.tenantId, tenantId), isNull(tasks.deletedAt)];
    if (storeId) baseConds.push(eq(tasks.storeId, storeId));

    const statusRows = (await this.db
      .select({
        status: tasks.status,
        count: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .where(and(...baseConds))
      .groupBy(tasks.status)) as Array<{ status: TaskStatus; count: number }>;

    const priorityRows = (await this.db
      .select({
        priority: tasks.priority,
        count: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .where(and(...baseConds))
      .groupBy(tasks.priority)) as Array<{ priority: TaskPriority; count: number }>;

    const typeRows = (await this.db
      .select({
        type: tasks.type,
        count: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .where(and(...baseConds))
      .groupBy(tasks.type)) as Array<{ type: TaskType; count: number }>;

    const [agg] = (await this.db
      .select({
        total: sql<number>`count(*)::int`,
        avgMinutes: sql<number | null>`avg(${tasks.actualDurationMinutes})`,
        completedTotal: sql<number>`sum(case when ${tasks.status} = 'completed' then 1 else 0 end)::int`,
        completedOnTime: sql<number>`sum(case when ${tasks.status} = 'completed' and ${tasks.completedAt} <= ${tasks.dueDate} then 1 else 0 end)::int`,
      })
      .from(tasks)
      .where(and(...baseConds))) as Array<{
      total: number;
      avgMinutes: number | null;
      completedTotal: number;
      completedOnTime: number;
    }>;

    const byStatus: Record<TaskStatus, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      rejected: 0,
      cancelled: 0,
      overdue: 0,
    };
    for (const r of statusRows) byStatus[r.status] = Number(r.count);

    const byPriority: Record<TaskPriority, number> = {
      low: 0,
      medium: 0,
      high: 0,
      urgent: 0,
    };
    for (const r of priorityRows) byPriority[r.priority] = Number(r.count);

    const byType: Record<TaskType, number> = {
      'expiry-check': 0,
      'shelf-audit': 0,
      'inventory-count': 0,
      'price-update': 0,
      cleaning: 0,
      restock: 0,
      training: 0,
      maintenance: 0,
      other: 0,
    };
    for (const r of typeRows) byType[r.type] = Number(r.count);

    const completedTotal = Number(agg?.completedTotal ?? 0);
    const completedOnTime = Number(agg?.completedOnTime ?? 0);
    const onTimeRate = completedTotal === 0 ? null : completedOnTime / completedTotal;
    const avgMinutes =
      agg?.avgMinutes === null || agg?.avgMinutes === undefined
        ? null
        : Math.round(Number(agg.avgMinutes));

    return {
      storeId,
      total: Number(agg?.total ?? 0),
      byStatus,
      byPriority,
      byType,
      byAssignee: [],
      averageCompletionMinutes: avgMinutes,
      onTimeRate,
    };
  }

  async getAssigneeStats(
    tenantId: string,
    storeId: string | null,
    limit = 50,
  ): Promise<AssigneeStat[]> {
    const where = storeId
      ? sql`t.tenant_id = ${tenantId} AND t.store_id = ${storeId} AND t.deleted_at IS NULL`
      : sql`t.tenant_id = ${tenantId} AND t.deleted_at IS NULL`;

    const result = (await this.db.execute(sql`
      SELECT a.assignee_id AS "userId",
             count(*)::int AS total,
             sum(case when t.status = 'completed' then 1 else 0 end)::int AS completed
      FROM task_assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.revoked_at IS NULL AND ${where}
      GROUP BY a.assignee_id
      ORDER BY total DESC
      LIMIT ${limit}
    `)) as unknown as { rows: AssigneeStat[] };

    return (result.rows ?? []).map((r) => ({
      userId: r.userId,
      total: Number(r.total),
      completed: Number(r.completed),
    }));
  }
}
