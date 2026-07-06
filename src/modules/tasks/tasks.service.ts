import { Injectable } from '@nestjs/common';

import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import {
  AddEvidenceDto,
  CompleteTaskDto,
  CreateTaskDto,
  ListTasksQueryDto,
  MyTasksQueryDto,
  ReassignTaskDto,
  StatsQueryDto,
  UpdateTaskDto,
} from './dto/tasks.dto';
import { TaskAssignmentsRepository } from './repositories/task-assignments.repository';
import { TaskEventsRepository } from './repositories/task-events.repository';
import { TasksRepository } from './repositories/tasks.repository';
import { RecurringTasksService } from './services/recurring-tasks.service';
import { TaskAssignmentService } from './services/task-assignment.service';
import { TaskEvidenceService } from './services/task-evidence.service';
import { TaskWorkflowService } from './services/task-workflow.service';
import type {
  OverdueSweepResult,
  Task,
  TaskStats,
  TaskStatus,
  TaskWithDetails,
} from './types/task.types';

/**
 * BE-19 — Top-level orchestrator.
 *
 *   Create / read / update / soft-delete tasks
 *   Workflow transitions: start, complete, reject, cancel
 *   Reassignment, evidence add/remove (delegated)
 *   Listings: per-tenant, per-store, "my tasks"
 *   Stats aggregation
 *   BE-24 cron entry: `markOverdue(now)`
 *   Recurring spawn on completion
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly db: DbService,
    private readonly tasksRepo: TasksRepository,
    private readonly assignmentsRepo: TaskAssignmentsRepository,
    private readonly eventsRepo: TaskEventsRepository,
    private readonly workflow: TaskWorkflowService,
    private readonly assignments: TaskAssignmentService,
    private readonly evidence: TaskEvidenceService,
    private readonly recurring: RecurringTasksService,
    private readonly audit: AuditLogService,
    private readonly logger: LoggerService,
  ) {}

  /* ─────────────────── CRUD ─────────────────── */

  async create(tenantId: string, actorId: string, dto: CreateTaskDto): Promise<Task> {
    return this.db.transaction(async (tx) => {
      const created = await this.tasksRepo.create(
        {
          tenantId,
          storeId: dto.storeId,
          title: dto.title,
          description: dto.description,
          type: dto.type,
          priority: dto.priority,
          status: 'pending',
          startDate: dto.startDate,
          dueDate: dto.dueDate,
          estimatedDurationMinutes: dto.estimatedDurationMinutes,
          requiresPhoto: dto.requiresPhoto,
          requiresScan: dto.requiresScan,
          minimumEvidenceCount: dto.minimumEvidenceCount,
          expiryAlertId: dto.expiryAlertId,
          productIds: dto.productIds ?? [],
          scanSessionId: dto.scanSessionId,
          templateId: dto.templateId,
          isRecurring: dto.isRecurring,
          recurrencePattern: dto.recurrencePattern,
          recurrenceOccurrenceCount: 0,
          evidenceCount: 0,
          assigneeCount: 0,
          metadata: dto.metadata ?? {},
          createdBy: actorId,
        },
        tx,
      );

      await this.assignments.assignBatch(created, dto.assigneeIds, 'primary', actorId, tx);
      if (dto.observerIds?.length) {
        await this.assignments.assignBatch(created, dto.observerIds, 'observer', actorId, tx);
      }

      await this.eventsRepo.create(
        {
          taskId: created.id,
          tenantId,
          type: 'created',
          actorId,
          toStatus: 'pending',
          metadata: {
            assigneeCount: dto.assigneeIds.length,
            ...(dto.observerIds?.length ? { observerCount: dto.observerIds.length } : {}),
          },
        },
        tx,
      );

      await this.audit.logAction({
        action: 'CREATE',
        resourceType: 'Task',
        resourceId: created.id,
        userId: actorId,
        tenantId,
        success: true,
        metadata: {
          type: dto.type,
          priority: dto.priority,
          storeId: dto.storeId,
          assignees: dto.assigneeIds,
        },
      });

      return created;
    });
  }

  async findById(tenantId: string, id: string): Promise<TaskWithDetails> {
    const task = await this.tasksRepo.findByIdInTenant(id, tenantId);
    if (!task) throw new DomainNotFoundException('Task', id);

    const [assignments, events, evidence] = await Promise.all([
      this.assignmentsRepo.listAllForTask(id),
      this.eventsRepo.findByTask(id, tenantId),
      this.evidence.listForTask(id),
    ]);

    return { ...task, assignments, events, evidence };
  }

  async update(tenantId: string, actorId: string, id: string, dto: UpdateTaskDto): Promise<Task> {
    const task = await this.tasksRepo.findByIdInTenant(id, tenantId);
    if (!task) throw new DomainNotFoundException('Task', id);
    if (this.workflow.isTerminal(task.status as TaskStatus)) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Cannot update a task in terminal status '${task.status}'`,
      );
    }

    return this.db.transaction(async (tx) => {
      const updated = await this.tasksRepo.update(id, { ...dto, updatedBy: actorId }, tx);
      await this.eventsRepo.create(
        {
          taskId: id,
          tenantId,
          type: 'updated',
          actorId,
          metadata: this.diffSummary(task, dto),
        },
        tx,
      );
      await this.audit.logAction({
        action: 'UPDATE',
        resourceType: 'Task',
        resourceId: id,
        userId: actorId,
        tenantId,
        success: true,
        metadata: { transition: 'edit' },
      });
      return updated;
    });
  }

  async delete(tenantId: string, actorId: string, id: string): Promise<void> {
    const task = await this.tasksRepo.findByIdInTenant(id, tenantId);
    if (!task) throw new DomainNotFoundException('Task', id);
    await this.tasksRepo.softDelete(id, actorId);
    await this.audit.logAction({
      action: 'DELETE',
      resourceType: 'Task',
      resourceId: id,
      userId: actorId,
      tenantId,
      success: true,
      metadata: { transition: 'soft-delete' },
    });
  }

  /* ─────────────────── Listing ─────────────────── */

  async list(tenantId: string, query: ListTasksQueryDto): Promise<Task[]> {
    return this.tasksRepo.listForTenant(tenantId, {
      storeId: query.storeId,
      assigneeId: query.assigneeId,
      status: query.status,
      priority: query.priority,
      type: query.type,
      dueBefore: query.dueBefore,
      dueAfter: query.dueAfter,
      templateId: query.templateId,
      parentTaskId: query.parentTaskId,
      expiryAlertId: query.expiryAlertId,
      limit: query.limit,
    });
  }

  async listForUser(tenantId: string, userId: string, query: MyTasksQueryDto): Promise<Task[]> {
    const rows = await this.assignmentsRepo.listTasksForUser(tenantId, userId, {
      status: query.status,
      storeId: query.storeId,
      limit: query.limit,
    });
    // dueBefore is applied client-side for the rare case it filters
    // results pulled by the joined query.
    if (query.dueBefore) {
      const cutoff = query.dueBefore.getTime();
      return rows.filter((t) => !!t.dueDate && t.dueDate.getTime() <= cutoff);
    }
    return rows;
  }

  /* ─────────────────── Workflow ─────────────────── */

  async start(tenantId: string, actorId: string, id: string): Promise<Task> {
    const task = await this.tasksRepo.findByIdInTenant(id, tenantId);
    if (!task) throw new DomainNotFoundException('Task', id);
    await this.assignments.assertActiveAssignment(id, actorId);
    this.workflow.validateTransition(task.status as TaskStatus, 'in_progress');

    return this.db.transaction(async (tx) => {
      const now = new Date();
      const updated = await this.tasksRepo.update(
        id,
        {
          status: 'in_progress',
          startedAt: now,
          updatedBy: actorId,
        },
        tx,
      );
      await this.eventsRepo.create(
        {
          taskId: id,
          tenantId,
          type: 'started',
          actorId,
          fromStatus: task.status,
          toStatus: 'in_progress',
        },
        tx,
      );
      await this.audit.logAction({
        action: 'UPDATE',
        resourceType: 'Task',
        resourceId: id,
        userId: actorId,
        tenantId,
        success: true,
        metadata: { transition: 'start' },
      });
      return updated;
    });
  }

  async complete(
    tenantId: string,
    actorId: string,
    id: string,
    dto: CompleteTaskDto,
  ): Promise<Task> {
    const task = await this.tasksRepo.findByIdInTenant(id, tenantId);
    if (!task) throw new DomainNotFoundException('Task', id);
    await this.assignments.assertActiveAssignment(id, actorId);
    this.workflow.validateTransition(task.status as TaskStatus, 'completed');

    const existingEvidence = await this.evidence.listForTask(id);
    this.evidence.ensureRequirementsMet({
      task,
      existingEvidence,
      incomingEvidence: dto.evidence ?? [],
      completionScanSessionId: dto.scanSessionId,
    });

    return this.db.transaction(async (tx) => {
      if (dto.evidence?.length) {
        await this.evidence.addMany(task, dto.evidence, actorId, tx);
      }

      const completedAt = new Date();
      const startedAt = task.startedAt ?? completedAt;
      const actualDurationMinutes = Math.max(
        0,
        Math.round((completedAt.getTime() - startedAt.getTime()) / 60000),
      );

      const updated = await this.tasksRepo.update(
        id,
        {
          status: 'completed',
          completedAt,
          actualDurationMinutes,
          ...(dto.scanSessionId ? { scanSessionId: dto.scanSessionId } : {}),
          updatedBy: actorId,
        },
        tx,
      );

      await this.eventsRepo.create(
        {
          taskId: id,
          tenantId,
          type: 'completed',
          actorId,
          fromStatus: task.status,
          toStatus: 'completed',
          notes: dto.notes,
          metadata: {
            actualDurationMinutes,
            evidenceAdded: dto.evidence?.length ?? 0,
            ...(dto.scanSessionId ? { scanSessionId: dto.scanSessionId } : {}),
          },
        },
        tx,
      );

      await this.audit.logAction({
        action: 'UPDATE',
        resourceType: 'Task',
        resourceId: id,
        userId: actorId,
        tenantId,
        success: true,
        metadata: {
          transition: 'complete',
          actualDurationMinutes,
          evidenceAdded: dto.evidence?.length ?? 0,
        },
      });

      if (task.isRecurring) {
        await this.recurring.spawnNextOccurrence(updated, actorId, tx);
      }

      return updated;
    });
  }

  async reject(tenantId: string, actorId: string, id: string, reason: string): Promise<Task> {
    const task = await this.tasksRepo.findByIdInTenant(id, tenantId);
    if (!task) throw new DomainNotFoundException('Task', id);
    await this.assignments.assertActiveAssignment(id, actorId);
    this.workflow.validateTransition(task.status as TaskStatus, 'rejected');

    return this.db.transaction(async (tx) => {
      const updated = await this.tasksRepo.update(
        id,
        { status: 'rejected', updatedBy: actorId },
        tx,
      );
      await this.eventsRepo.create(
        {
          taskId: id,
          tenantId,
          type: 'rejected',
          actorId,
          fromStatus: task.status,
          toStatus: 'rejected',
          notes: reason,
        },
        tx,
      );
      await this.audit.logAction({
        action: 'UPDATE',
        resourceType: 'Task',
        resourceId: id,
        userId: actorId,
        tenantId,
        success: true,
        metadata: { transition: 'reject', reason },
      });
      return updated;
    });
  }

  async cancel(tenantId: string, actorId: string, id: string, reason: string): Promise<Task> {
    const task = await this.tasksRepo.findByIdInTenant(id, tenantId);
    if (!task) throw new DomainNotFoundException('Task', id);
    this.workflow.validateTransition(task.status as TaskStatus, 'cancelled');

    return this.db.transaction(async (tx) => {
      const updated = await this.tasksRepo.update(
        id,
        { status: 'cancelled', updatedBy: actorId },
        tx,
      );
      await this.eventsRepo.create(
        {
          taskId: id,
          tenantId,
          type: 'cancelled',
          actorId,
          fromStatus: task.status,
          toStatus: 'cancelled',
          notes: reason,
        },
        tx,
      );
      await this.audit.logAction({
        action: 'UPDATE',
        resourceType: 'Task',
        resourceId: id,
        userId: actorId,
        tenantId,
        success: true,
        metadata: { transition: 'cancel', reason },
      });
      return updated;
    });
  }

  /* ─────────────────── Reassignment ─────────────────── */

  async reassign(
    tenantId: string,
    actorId: string,
    id: string,
    dto: ReassignTaskDto,
  ): Promise<Task> {
    const task = await this.tasksRepo.findByIdInTenant(id, tenantId);
    if (!task) throw new DomainNotFoundException('Task', id);
    if (this.workflow.isTerminal(task.status as TaskStatus)) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Cannot reassign a task in terminal status '${task.status}'`,
      );
    }
    return this.db.transaction(async (tx) => {
      const result = await this.assignments.reassign(
        task,
        dto.assigneeIds,
        dto.role,
        actorId,
        { reason: dto.reason, replace: dto.replace },
        tx,
      );
      await this.audit.logAction({
        action: 'UPDATE',
        resourceType: 'Task',
        resourceId: id,
        userId: actorId,
        tenantId,
        success: true,
        metadata: {
          transition: 'reassign',
          revokedCount: result.revokedCount,
          addedCount: result.addedAssignments.length,
          ...(dto.reason ? { reason: dto.reason } : {}),
        },
      });
      // Re-read for fresh denormalised counters.
      const fresh = await this.tasksRepo.findByIdInTenant(id, tenantId);
      return fresh ?? task;
    });
  }

  /* ─────────────────── Evidence (controller façade) ─────────────────── */

  async addEvidence(tenantId: string, actorId: string, taskId: string, dto: AddEvidenceDto) {
    const task = await this.tasksRepo.findByIdInTenant(taskId, tenantId);
    if (!task) throw new DomainNotFoundException('Task', taskId);
    await this.assignments.assertActiveAssignment(taskId, actorId);
    if (this.workflow.isTerminal(task.status as TaskStatus)) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Cannot add evidence to a task in terminal status '${task.status}'`,
      );
    }
    return this.db.transaction((tx) => this.evidence.add(task, dto, actorId, tx));
  }

  async removeEvidence(tenantId: string, actorId: string, evidenceId: string): Promise<void> {
    await this.evidence.remove(tenantId, actorId, evidenceId);
  }

  /* ─────────────────── Stats ─────────────────── */

  async getStats(tenantId: string, query: StatsQueryDto): Promise<TaskStats> {
    const stats = await this.tasksRepo.getStats(tenantId, query.storeId ?? null);
    const byAssignee = await this.tasksRepo.getAssigneeStats(tenantId, query.storeId ?? null, 50);
    return { ...stats, byAssignee };
  }

  /* ─────────────────── Overdue sweep (BE-24 cron) ─────────────────── */

  async markOverdue(now: Date = new Date()): Promise<OverdueSweepResult> {
    const candidates = await this.tasksRepo.findOverdueCandidates(now, 500);
    if (candidates.length === 0) return { scanned: 0, marked: 0 };

    let marked = 0;
    for (const candidate of candidates) {
      try {
        await this.db.transaction(async (tx: Transaction) => {
          await this.tasksRepo.markOverdue(candidate.id, now, tx);
          await this.eventsRepo.create(
            {
              taskId: candidate.id,
              tenantId: candidate.tenantId,
              type: 'overdue',
              actorId: candidate.createdBy ?? candidate.tenantId,
              fromStatus: candidate.status,
              toStatus: 'overdue',
              metadata: {
                dueDate: candidate.dueDate?.toISOString() ?? null,
              },
            },
            tx,
          );
        });
        marked++;
      } catch (err) {
        this.logger.warn('tasks.overdue.mark_failed', {
          taskId: candidate.id,
          error: { name: (err as Error).name, message: (err as Error).message },
        });
      }
    }

    this.logger.info('tasks.overdue.swept', {
      scanned: candidates.length,
      marked,
    });
    return { scanned: candidates.length, marked };
  }

  /* ─────────────────── Helpers ─────────────────── */

  private diffSummary(before: Task, after: UpdateTaskDto): Record<string, unknown> {
    const changes: Record<string, unknown> = {};
    for (const key of Object.keys(after) as Array<keyof UpdateTaskDto>) {
      const next = (after as Record<string, unknown>)[key];
      const prev = (before as unknown as Record<string, unknown>)[key];
      if (next !== undefined && JSON.stringify(prev) !== JSON.stringify(next)) {
        changes[key] = { from: prev, to: next };
      }
    }
    return changes;
  }
}
