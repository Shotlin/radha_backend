import { Injectable } from '@nestjs/common';

import {
  BusinessException,
  DomainForbiddenException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Transaction } from '@/db/connection';

import type { AddEvidenceDto } from '../dto/tasks.dto';
import { TaskEventsRepository } from '../repositories/task-events.repository';
import { TaskEvidenceRepository } from '../repositories/task-evidence.repository';
import { TasksRepository } from '../repositories/tasks.repository';
import type { Task, TaskEvidence } from '../types/task.types';

/**
 * BE-19 — Evidence lifecycle.
 *
 * The DTO refine already enforces "the field required for the type
 * is present" so we can trust the shape here. This service:
 *   - persists rows
 *   - keeps `tasks.evidenceCount` in sync atomically
 *   - emits `evidence_added` / `evidence_removed` audit events
 *   - enforces "minimum evidence count" before completion (called
 *     from `TasksService.complete`)
 */
@Injectable()
export class TaskEvidenceService {
  constructor(
    private readonly evidenceRepo: TaskEvidenceRepository,
    private readonly tasksRepo: TasksRepository,
    private readonly eventsRepo: TaskEventsRepository,
  ) {}

  async add(
    task: Task,
    dto: AddEvidenceDto,
    addedBy: string,
    tx: Transaction,
  ): Promise<TaskEvidence> {
    const created = await this.evidenceRepo.create(
      {
        taskId: task.id,
        tenantId: task.tenantId,
        type: dto.type,
        mediaId: dto.mediaId,
        scanSessionId: dto.scanSessionId,
        note: dto.note,
        addedBy,
        metadata: dto.metadata ?? {},
      },
      tx,
    );

    await this.tasksRepo.incrementCounter(task.id, 'evidenceCount', 1, tx);

    await this.eventsRepo.create(
      {
        taskId: task.id,
        tenantId: task.tenantId,
        type: 'evidence_added',
        actorId: addedBy,
        metadata: {
          evidenceId: created.id,
          evidenceType: dto.type,
          ...(dto.mediaId ? { mediaId: dto.mediaId } : {}),
          ...(dto.scanSessionId ? { scanSessionId: dto.scanSessionId } : {}),
        },
      },
      tx,
    );

    return created;
  }

  async addMany(
    task: Task,
    items: AddEvidenceDto[],
    addedBy: string,
    tx: Transaction,
  ): Promise<TaskEvidence[]> {
    const created: TaskEvidence[] = [];
    for (const dto of items) {
      created.push(await this.add(task, dto, addedBy, tx));
    }
    return created;
  }

  async listForTask(taskId: string): Promise<TaskEvidence[]> {
    return this.evidenceRepo.listForTask(taskId);
  }

  async remove(tenantId: string, actorId: string, evidenceId: string): Promise<void> {
    const row = await this.evidenceRepo.findByIdInTenant(evidenceId, tenantId);
    if (!row) throw new DomainNotFoundException('TaskEvidence', evidenceId);
    if (row.addedBy !== actorId) {
      // Authors can remove their own evidence; managers route through
      // this with elevated permissions covered by the controller.
      // We keep the service strict so unit tests pin the rule.
      throw new DomainForbiddenException('Only the original uploader may remove their evidence');
    }
    await this.evidenceRepo.softDelete(evidenceId, actorId);
    await this.tasksRepo.incrementCounter(row.taskId, 'evidenceCount', -1);
    await this.eventsRepo.create({
      taskId: row.taskId,
      tenantId: row.tenantId,
      type: 'evidence_removed',
      actorId,
      metadata: {
        evidenceId: row.id,
        evidenceType: row.type,
      },
    });
  }

  /**
   * Validate evidence requirements at task-completion time. Called
   * from `TasksService.complete` *before* the transaction body runs
   * the actual transition.
   *
   *   - `requiresPhoto` → at least one photo evidence on the task
   *     (existing or in the new batch).
   *   - `requiresScan`  → at least one scan evidence (existing,
   *     in the new batch, or `scanSessionId` provided in dto).
   *   - `minimumEvidenceCount` → existing + new evidence count >= N.
   */
  ensureRequirementsMet(input: {
    task: Task;
    existingEvidence: TaskEvidence[];
    incomingEvidence: AddEvidenceDto[];
    completionScanSessionId: string | undefined;
  }): void {
    const all: Array<{
      type: TaskEvidence['type'];
      mediaId?: string | null;
      scanSessionId?: string | null;
    }> = [
      ...input.existingEvidence.map((e) => ({
        type: e.type,
        mediaId: e.mediaId,
        scanSessionId: e.scanSessionId,
      })),
      ...input.incomingEvidence.map((e) => ({
        type: e.type,
        mediaId: e.mediaId,
        scanSessionId: e.scanSessionId,
      })),
    ];

    if (input.task.minimumEvidenceCount > 0 && all.length < input.task.minimumEvidenceCount) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Minimum ${input.task.minimumEvidenceCount} evidence items required to complete this task`,
        {
          metadata: {
            required: input.task.minimumEvidenceCount,
            provided: all.length,
          },
        },
      );
    }

    if (input.task.requiresPhoto) {
      const hasPhoto = all.some((e) => e.type === 'photo' && !!e.mediaId);
      if (!hasPhoto) {
        throw new BusinessException(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'This task requires at least one photo as evidence',
        );
      }
    }

    if (input.task.requiresScan) {
      const hasScanEvidence = all.some((e) => e.type === 'scan' && !!e.scanSessionId);
      const hasInlineScan = !!input.completionScanSessionId || !!input.task.scanSessionId;
      if (!hasScanEvidence && !hasInlineScan) {
        throw new BusinessException(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'This task requires a scan session as evidence',
        );
      }
    }
  }
}
