import { Injectable } from '@nestjs/common';

import {
  DomainForbiddenException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import type { Transaction } from '@/db/connection';
import { LoggerService } from '@/logging/logger.service';

import { TaskAssignmentsRepository } from '../repositories/task-assignments.repository';
import { TaskEventsRepository } from '../repositories/task-events.repository';
import { TasksRepository } from '../repositories/tasks.repository';
import type { Task, TaskAssignment, TaskAssignmentRoleType } from '../types/task.types';

/**
 * BE-19 — Assignment lifecycle.
 *
 * Modelled as **revoke + create** rather than mutate so the audit
 * trail is clean and a previously-revoked assignee can be re-added
 * later (the partial unique index allows it).
 *
 * Caller checks (e.g. "is the actor a manager?") happen in the
 * controller via `RolesGuard`; this service trusts that contract and
 * focuses on data integrity.
 */
@Injectable()
export class TaskAssignmentService {
  constructor(
    private readonly assignmentsRepo: TaskAssignmentsRepository,
    private readonly eventsRepo: TaskEventsRepository,
    private readonly tasksRepo: TasksRepository,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Initial assignment at task-create time. Idempotent: duplicates
   * inside the same call are deduped before insert.
   */
  async assignBatch(
    task: Task,
    assigneeIds: string[],
    role: TaskAssignmentRoleType,
    actorId: string,
    tx: Transaction,
  ): Promise<TaskAssignment[]> {
    const unique = [...new Set(assigneeIds)];
    const created: TaskAssignment[] = [];
    for (const assigneeId of unique) {
      const inserted = await this.assignmentsRepo.insertIfMissing(
        {
          taskId: task.id,
          assigneeId,
          tenantId: task.tenantId,
          role,
          assignedBy: actorId,
        },
        tx,
      );
      if (inserted) {
        created.push(inserted);
        await this.eventsRepo.create(
          {
            taskId: task.id,
            tenantId: task.tenantId,
            type: 'assigned',
            actorId,
            metadata: { assigneeId, role },
          },
          tx,
        );
      }
    }
    if (created.length > 0) {
      await this.tasksRepo.incrementCounter(task.id, 'assigneeCount', created.length, tx);
    }
    return created;
  }

  /**
   * Replace primary assignees: revokes every active primary
   * assignment, then assigns the new set. Observers are untouched.
   */
  async reassign(
    task: Task,
    newAssigneeIds: string[],
    role: TaskAssignmentRoleType,
    actorId: string,
    options: { reason?: string; replace: boolean },
    tx: Transaction,
  ): Promise<{
    revokedCount: number;
    addedAssignments: TaskAssignment[];
  }> {
    let revokedCount = 0;
    if (options.replace) {
      revokedCount = await this.assignmentsRepo.revokeAllPrimary(
        task.id,
        actorId,
        options.reason,
        tx,
      );
      if (revokedCount > 0) {
        await this.tasksRepo.incrementCounter(task.id, 'assigneeCount', -revokedCount, tx);
      }
    }

    const added = await this.assignBatch(task, newAssigneeIds, role, actorId, tx);

    await this.eventsRepo.create(
      {
        taskId: task.id,
        tenantId: task.tenantId,
        type: 'reassigned',
        actorId,
        notes: options.reason,
        metadata: {
          revokedCount,
          addedCount: added.length,
          newAssigneeIds: [...new Set(newAssigneeIds)],
          role,
        },
      },
      tx,
    );

    return { revokedCount, addedAssignments: added };
  }

  async unassign(
    task: Task,
    assigneeId: string,
    actorId: string,
    reason: string | undefined,
    tx: Transaction,
  ): Promise<TaskAssignment> {
    const revoked = await this.assignmentsRepo.revoke(task.id, assigneeId, actorId, reason, tx);
    if (!revoked) {
      throw new DomainNotFoundException('TaskAssignment', `${task.id}:${assigneeId}`);
    }
    await this.tasksRepo.incrementCounter(task.id, 'assigneeCount', -1, tx);
    await this.eventsRepo.create(
      {
        taskId: task.id,
        tenantId: task.tenantId,
        type: 'unassigned',
        actorId,
        notes: reason,
        metadata: { assigneeId },
      },
      tx,
    );
    return revoked;
  }

  /**
   * Throws `DomainForbiddenException` unless `userId` has an active
   * assignment to the task. Used by start/complete/reject + evidence
   * routes.
   */
  async assertActiveAssignment(taskId: string, userId: string): Promise<TaskAssignment> {
    const assignment = await this.assignmentsRepo.findActiveByTaskAndUser(taskId, userId);
    if (!assignment) {
      throw new DomainForbiddenException('You are not assigned to this task');
    }
    return assignment;
  }
}
