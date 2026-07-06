import { Injectable } from '@nestjs/common';

import type { Transaction } from '@/db/connection';
import { LoggerService } from '@/logging/logger.service';

import { TaskAssignmentsRepository } from '../repositories/task-assignments.repository';
import { TaskEventsRepository } from '../repositories/task-events.repository';
import { TasksRepository } from '../repositories/tasks.repository';
import type { RecurrencePattern, Task, TaskAssignmentRoleType } from '../types/task.types';
import {
  calculateNextDueDate,
  hasRemainingOccurrences,
  isRecurrencePattern,
} from '../utils/recurrence.utils';

/**
 * BE-19 — Recurring tasks.
 *
 *   - When a recurring task completes (`isRecurring=true` AND
 *     `recurrencePattern` is well-formed AND occurrence quota not
 *     exhausted), `spawnNextOccurrence` is invoked from inside the
 *     same transaction as the completion.
 *   - The new task copies most fields from the parent, resets all
 *     state-tracking fields (status, startedAt, completedAt,
 *     duration, evidence/assignee counters), shifts the dueDate by
 *     the configured pattern, and links via `parentTaskId`.
 *   - The parent's `recurrenceOccurrenceCount` is bumped atomically.
 *   - All active assignments on the parent are copied verbatim onto
 *     the child so the same crew is on the hook the next day.
 */
@Injectable()
export class RecurringTasksService {
  constructor(
    private readonly tasksRepo: TasksRepository,
    private readonly assignmentsRepo: TaskAssignmentsRepository,
    private readonly eventsRepo: TaskEventsRepository,
    private readonly logger: LoggerService,
  ) {}

  async spawnNextOccurrence(parent: Task, actorId: string, tx: Transaction): Promise<Task | null> {
    if (!parent.isRecurring) return null;
    const pattern = parent.recurrencePattern;
    if (!isRecurrencePattern(pattern)) return null;
    if (!hasRemainingOccurrences(pattern as RecurrencePattern, parent.recurrenceOccurrenceCount)) {
      return null;
    }

    const previousDue = parent.dueDate ?? parent.completedAt ?? new Date();
    const nextDue = calculateNextDueDate(
      previousDue,
      pattern as RecurrencePattern,
      parent.recurrenceOccurrenceCount,
    );
    if (!nextDue) return null;

    const child = await this.tasksRepo.create(
      {
        tenantId: parent.tenantId,
        storeId: parent.storeId,
        title: parent.title,
        description: parent.description,
        type: parent.type,
        priority: parent.priority,
        status: 'pending',
        startDate: null,
        dueDate: nextDue,
        startedAt: null,
        completedAt: null,
        estimatedDurationMinutes: parent.estimatedDurationMinutes,
        actualDurationMinutes: null,
        requiresPhoto: parent.requiresPhoto,
        requiresScan: parent.requiresScan,
        minimumEvidenceCount: parent.minimumEvidenceCount,
        expiryAlertId: null, // each occurrence handles its own alerts
        productIds: parent.productIds,
        scanSessionId: null,
        templateId: parent.templateId,
        isRecurring: false, // child instances are not themselves recurring
        recurrencePattern: null,
        parentTaskId: parent.id,
        recurrenceOccurrenceCount: 0,
        evidenceCount: 0,
        assigneeCount: 0,
        overdueMarkedAt: null,
        metadata: parent.metadata,
        createdBy: actorId,
      },
      tx,
    );

    // Copy active assignments forward.
    const activeAssignments = await this.assignmentsRepo.listActiveForTask(parent.id);
    let copied = 0;
    for (const a of activeAssignments) {
      const inserted = await this.assignmentsRepo.insertIfMissing(
        {
          taskId: child.id,
          assigneeId: a.assigneeId,
          tenantId: child.tenantId,
          role: a.role as TaskAssignmentRoleType,
          assignedBy: actorId,
        },
        tx,
      );
      if (inserted) copied++;
    }
    if (copied > 0) {
      await this.tasksRepo.incrementCounter(child.id, 'assigneeCount', copied, tx);
    }

    // Bump parent counter + log spawn event on the child.
    await this.tasksRepo.incrementCounter(parent.id, 'recurrenceOccurrenceCount', 1, tx);
    await this.eventsRepo.create(
      {
        taskId: child.id,
        tenantId: child.tenantId,
        type: 'recurrence_spawned',
        actorId,
        metadata: {
          parentTaskId: parent.id,
          dueDate: nextDue.toISOString(),
          assigneesCopied: copied,
        },
      },
      tx,
    );

    this.logger.info('tasks.recurrence.spawned', {
      parentTaskId: parent.id,
      childTaskId: child.id,
      dueDate: nextDue.toISOString(),
    });

    return child;
  }
}
