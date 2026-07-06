import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewTaskAssignment, TaskAssignmentRow, taskAssignments, tasks } from '@/db/schema/tasks';

import type { Task, TaskStatus } from '../types/task.types';

/**
 * BE-19 — `task_assignments` table data access.
 *
 *   - active assignment = `revokedAt IS NULL`
 *   - listing for a user only returns rows for non-deleted tasks
 *   - cross-tenant lookups blocked via the `tenantId` column carried
 *     on the assignment for join-free guard checks.
 */
@Injectable()
export class TaskAssignmentsRepository extends BaseRepository<
  typeof taskAssignments,
  TaskAssignmentRow,
  NewTaskAssignment,
  Partial<NewTaskAssignment>
> {
  constructor(db: DbService) {
    super(db.getDb(), taskAssignments, 'task_assignments');
  }

  async findActiveByTaskAndUser(
    taskId: string,
    assigneeId: string,
  ): Promise<TaskAssignmentRow | null> {
    const [row] = await this.db
      .select()
      .from(taskAssignments)
      .where(
        and(
          eq(taskAssignments.taskId, taskId),
          eq(taskAssignments.assigneeId, assigneeId),
          isNull(taskAssignments.revokedAt),
        ),
      )
      .limit(1);
    return (row as TaskAssignmentRow | undefined) ?? null;
  }

  async listActiveForTask(taskId: string): Promise<TaskAssignmentRow[]> {
    return (await this.db
      .select()
      .from(taskAssignments)
      .where(and(eq(taskAssignments.taskId, taskId), isNull(taskAssignments.revokedAt)))
      .orderBy(asc(taskAssignments.assignedAt))) as TaskAssignmentRow[];
  }

  async listAllForTask(taskId: string): Promise<TaskAssignmentRow[]> {
    return (await this.db
      .select()
      .from(taskAssignments)
      .where(eq(taskAssignments.taskId, taskId))
      .orderBy(asc(taskAssignments.assignedAt))) as TaskAssignmentRow[];
  }

  async listTasksForUser(
    tenantId: string,
    userId: string,
    filters: {
      status?: TaskStatus[];
      storeId?: string;
      limit: number;
    },
  ): Promise<Task[]> {
    const conds = [
      eq(taskAssignments.tenantId, tenantId),
      eq(taskAssignments.assigneeId, userId),
      isNull(taskAssignments.revokedAt),
      isNull(tasks.deletedAt),
      eq(tasks.tenantId, tenantId),
    ];
    if (filters.status?.length) conds.push(inArray(tasks.status, filters.status));
    if (filters.storeId) conds.push(eq(tasks.storeId, filters.storeId));

    const rows = await this.db
      .select({ task: tasks })
      .from(taskAssignments)
      .innerJoin(tasks, eq(tasks.id, taskAssignments.taskId))
      .where(and(...conds))
      .orderBy(desc(tasks.priority), asc(tasks.dueDate), desc(tasks.createdAt))
      .limit(filters.limit);

    return (rows as Array<{ task: Task }>).map((r) => r.task);
  }

  async insertIfMissing(
    data: NewTaskAssignment,
    tx?: Transaction,
  ): Promise<TaskAssignmentRow | null> {
    const scope = tx ?? this.db;
    const rows = (await scope
      .insert(taskAssignments)
      .values(data)
      .onConflictDoNothing({
        target: [taskAssignments.taskId, taskAssignments.assigneeId],
      })
      .returning()) as TaskAssignmentRow[];
    return rows[0] ?? null;
  }

  async revoke(
    taskId: string,
    assigneeId: string,
    revokedBy: string,
    reason: string | undefined,
    tx?: Transaction,
  ): Promise<TaskAssignmentRow | null> {
    const scope = tx ?? this.db;
    const [row] = await scope
      .update(taskAssignments)
      .set({
        revokedAt: new Date(),
        revokedBy,
        revokedReason: reason,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(taskAssignments.taskId, taskId),
          eq(taskAssignments.assigneeId, assigneeId),
          isNull(taskAssignments.revokedAt),
        ),
      )
      .returning();
    return (row as TaskAssignmentRow | undefined) ?? null;
  }

  async revokeAllPrimary(
    taskId: string,
    revokedBy: string,
    reason: string | undefined,
    tx?: Transaction,
  ): Promise<number> {
    const scope = tx ?? this.db;
    const result = await scope
      .update(taskAssignments)
      .set({
        revokedAt: new Date(),
        revokedBy,
        revokedReason: reason,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(taskAssignments.taskId, taskId),
          eq(taskAssignments.role, 'primary'),
          isNull(taskAssignments.revokedAt),
        ),
      )
      .returning({ id: taskAssignments.id });
    return (result as Array<{ id: string }>).length;
  }

  async countActive(taskId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(taskAssignments)
      .where(and(eq(taskAssignments.taskId, taskId), isNull(taskAssignments.revokedAt)));
    return Number(row?.value ?? 0);
  }
}
