import { Injectable } from '@nestjs/common';

import { DomainNotFoundException } from '@/common/errors/business.exception';
import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import { ExpiryAlertsRepository } from '@/modules/expiry/repositories/expiry-alerts.repository';
import { AuditLogService } from '@/observability/audit-log.service';

import { AutoTaskFromAlertDto } from '../dto/tasks.dto';
import { TaskEventsRepository } from '../repositories/task-events.repository';
import { TasksRepository } from '../repositories/tasks.repository';
import type { Task, TaskPriority, TaskType } from '../types/task.types';

import { TaskAssignmentService } from './task-assignment.service';

/**
 * BE-19 — Auto-create tasks from BE-18 expiry alerts.
 *
 * Idempotent at the DB level via the partial unique index
 * `idx_tasks_expiry_alert_active_uniq` — re-calling
 * `generateForAlert` for the same alert returns the existing task
 * instead of creating a duplicate.
 *
 * Priority is mapped from the alert's expiry status:
 *   red     → urgent
 *   yellow  → high
 *   expired → urgent
 */
@Injectable()
export class AutoTaskGeneratorService {
  static readonly DEFAULT_DUE_OFFSET_MS = 24 * 60 * 60 * 1000;

  constructor(
    private readonly db: DbService,
    private readonly tasksRepo: TasksRepository,
    private readonly eventsRepo: TaskEventsRepository,
    private readonly assignments: TaskAssignmentService,
    private readonly alertsRepo: ExpiryAlertsRepository,
    private readonly audit: AuditLogService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Look up the alert in the tenant, then create a task linked via
   * `expiryAlertId`. Returns the existing task when one is already
   * linked.
   */
  async generateForAlert(
    tenantId: string,
    actorId: string,
    dto: AutoTaskFromAlertDto,
  ): Promise<Task> {
    const alert = await this.alertsRepo.findByIdInTenant(dto.alertId, tenantId);
    if (!alert) throw new DomainNotFoundException('ExpiryAlert', dto.alertId);

    const existing = await this.tasksRepo.findByExpiryAlert(tenantId, dto.alertId);
    if (existing) {
      this.logger.info('tasks.auto.alert.skipped_existing', {
        alertId: dto.alertId,
        existingTaskId: existing.id,
      });
      return existing;
    }

    const priority: TaskPriority = alert.status === 'yellow' ? 'high' : 'urgent';
    const dueDate = new Date(Date.now() + dto.dueOffsetMinutes * 60 * 1000);

    const taskType: TaskType = 'expiry-check';

    return this.db.transaction(async (tx) => {
      const created = await this.tasksRepo.create(
        {
          tenantId,
          storeId: dto.storeId,
          title: this.buildTitle(alert.status, alert.daysRemaining),
          description: this.buildDescription(alert.quantity),
          type: taskType,
          priority,
          status: 'pending',
          startDate: null,
          dueDate,
          requiresPhoto: false,
          requiresScan: true,
          minimumEvidenceCount: 1,
          expiryAlertId: alert.id,
          productIds: [alert.productId],
          isRecurring: false,
          recurrenceOccurrenceCount: 0,
          evidenceCount: 0,
          assigneeCount: 0,
          metadata: {
            generator: 'expiry-alert',
            alertStatus: alert.status,
            alertDaysRemaining: alert.daysRemaining,
            quantity: alert.quantity,
          },
          createdBy: actorId,
        },
        tx,
      );

      await this.assignments.assignBatch(created, dto.assigneeIds, 'primary', actorId, tx);

      await this.eventsRepo.create(
        {
          taskId: created.id,
          tenantId,
          type: 'created',
          actorId,
          toStatus: 'pending',
          metadata: {
            generator: 'expiry-alert',
            alertId: alert.id,
            assigneeCount: dto.assigneeIds.length,
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
          transition: 'auto-from-expiry-alert',
          alertId: alert.id,
          priority,
        },
      });

      return created;
    });
  }

  private buildTitle(status: string, daysRemaining: number | null): string {
    if (status === 'red' || status === 'expired') {
      return `Remove or discount expiring/expired stock`;
    }
    return `Discount near-expiry stock${daysRemaining !== null ? ` (${daysRemaining} days)` : ''}`;
  }

  private buildDescription(quantity: number): string {
    return `Auto-generated from expiry alert. Quantity flagged: ${quantity}.`;
  }
}
