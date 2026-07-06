import { Injectable } from '@nestjs/common';

import {
  DomainConflictException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import {
  CreateTemplateDto,
  InstantiateTemplateDto,
  ListTemplatesQueryDto,
  UpdateTemplateDto,
} from '../dto/tasks.dto';
import { TaskTemplatesRepository } from '../repositories/task-templates.repository';
import type { RecurrencePattern, Task, TaskTemplate } from '../types/task.types';
import { isRecurrencePattern } from '../utils/recurrence.utils';

import { TasksService } from '../tasks.service';

/**
 * BE-19 — Template CRUD + instantiation.
 *
 * Templates carry default field values. Instantiating one creates a
 * full task by overlaying the caller's `InstantiateTemplateDto`.
 */
@Injectable()
export class TaskTemplatesService {
  constructor(
    private readonly templatesRepo: TaskTemplatesRepository,
    private readonly tasksService: TasksService,
    private readonly audit: AuditLogService,
    private readonly logger: LoggerService,
  ) {}

  async create(tenantId: string, actorId: string, dto: CreateTemplateDto): Promise<TaskTemplate> {
    const existing = await this.templatesRepo.findByNameInTenant(tenantId, dto.name);
    if (existing) {
      throw new DomainConflictException(
        `Template '${dto.name}' already exists`,
        ErrorCode.DUPLICATE_RESOURCE,
        { metadata: { name: dto.name } },
      );
    }
    const created = await this.templatesRepo.create({
      tenantId,
      name: dto.name,
      description: dto.description,
      type: dto.type,
      priority: dto.priority,
      titleTemplate: dto.titleTemplate,
      defaultDueOffsetMinutes: dto.defaultDueOffsetMinutes,
      estimatedDurationMinutes: dto.estimatedDurationMinutes,
      requiresPhoto: dto.requiresPhoto,
      requiresScan: dto.requiresScan,
      minimumEvidenceCount: dto.minimumEvidenceCount,
      isRecurring: dto.isRecurring,
      recurrencePattern: dto.recurrencePattern,
      isActive: true,
      metadata: dto.metadata ?? {},
      createdBy: actorId,
    });

    await this.audit.logAction({
      action: 'CREATE',
      resourceType: 'TaskTemplate',
      resourceId: created.id,
      userId: actorId,
      tenantId,
      success: true,
      metadata: { name: created.name, type: created.type },
    });
    return created;
  }

  async findById(tenantId: string, id: string): Promise<TaskTemplate> {
    const row = await this.templatesRepo.findByIdInTenant(id, tenantId);
    if (!row) throw new DomainNotFoundException('TaskTemplate', id);
    return row;
  }

  async list(tenantId: string, query: ListTemplatesQueryDto): Promise<TaskTemplate[]> {
    return this.templatesRepo.listForTenant(tenantId, {
      isActive: query.isActive,
      type: query.type,
      limit: query.limit,
    });
  }

  async update(
    tenantId: string,
    actorId: string,
    id: string,
    dto: UpdateTemplateDto,
  ): Promise<TaskTemplate> {
    const existing = await this.findById(tenantId, id);
    const updated = await this.templatesRepo.update(id, {
      ...dto,
      updatedBy: actorId,
    });
    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'TaskTemplate',
      resourceId: id,
      userId: actorId,
      tenantId,
      success: true,
      metadata: {
        transition: 'edit',
        before: { name: existing.name, isActive: existing.isActive },
      },
    });
    return updated;
  }

  async delete(tenantId: string, actorId: string, id: string): Promise<void> {
    await this.findById(tenantId, id);
    await this.templatesRepo.softDelete(id, actorId);
    await this.audit.logAction({
      action: 'DELETE',
      resourceType: 'TaskTemplate',
      resourceId: id,
      userId: actorId,
      tenantId,
      success: true,
      metadata: { transition: 'soft-delete' },
    });
  }

  /**
   * Build a `CreateTaskDto` from the template + caller overrides and
   * delegate to `TasksService.create`.
   */
  async instantiate(
    tenantId: string,
    actorId: string,
    templateId: string,
    overrides: InstantiateTemplateDto,
  ): Promise<Task> {
    const template = await this.findById(tenantId, templateId);
    if (!template.isActive) {
      throw new DomainConflictException(
        `Template '${template.name}' is inactive`,
        ErrorCode.BUSINESS_RULE_VIOLATION,
      );
    }
    const dueDate =
      overrides.dueDate ??
      (template.defaultDueOffsetMinutes !== null && template.defaultDueOffsetMinutes !== undefined
        ? new Date(Date.now() + template.defaultDueOffsetMinutes * 60 * 1000)
        : undefined);

    const recurrencePattern = isRecurrencePattern(template.recurrencePattern)
      ? (template.recurrencePattern as RecurrencePattern)
      : undefined;

    return this.tasksService.create(tenantId, actorId, {
      title: overrides.title ?? template.titleTemplate,
      description: template.description ?? undefined,
      type: template.type,
      priority: template.priority,
      storeId: overrides.storeId,
      assigneeIds: overrides.assigneeIds,
      dueDate,
      estimatedDurationMinutes: template.estimatedDurationMinutes ?? undefined,
      requiresPhoto: template.requiresPhoto,
      requiresScan: template.requiresScan,
      minimumEvidenceCount: template.minimumEvidenceCount,
      isRecurring: template.isRecurring,
      recurrencePattern,
      templateId: template.id,
      metadata: {
        ...overrides.metadata,
        fromTemplate: template.id,
        templateName: template.name,
      },
    });
  }
}
