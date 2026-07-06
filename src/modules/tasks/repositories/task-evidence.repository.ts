import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewTaskEvidence, TaskEvidenceRow, taskEvidence } from '@/db/schema/tasks';

/**
 * BE-19 — `task_evidence` data access.
 *
 * Soft-delete supported (BE-13 audit retention). Listing excludes
 * deleted rows by default; the audit/forensics path can pass
 * `includeDeleted: true` if it ever lands in the dashboard.
 */
@Injectable()
export class TaskEvidenceRepository extends BaseRepository<
  typeof taskEvidence,
  TaskEvidenceRow,
  NewTaskEvidence,
  Partial<NewTaskEvidence>
> {
  constructor(db: DbService) {
    super(db.getDb(), taskEvidence, 'task_evidence');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<TaskEvidenceRow | null> {
    const [row] = await this.db
      .select()
      .from(taskEvidence)
      .where(
        and(
          eq(taskEvidence.id, id),
          eq(taskEvidence.tenantId, tenantId),
          isNull(taskEvidence.deletedAt),
        ),
      )
      .limit(1);
    return (row as TaskEvidenceRow | undefined) ?? null;
  }

  async listForTask(taskId: string): Promise<TaskEvidenceRow[]> {
    return (await this.db
      .select()
      .from(taskEvidence)
      .where(and(eq(taskEvidence.taskId, taskId), isNull(taskEvidence.deletedAt)))
      .orderBy(asc(taskEvidence.createdAt))) as TaskEvidenceRow[];
  }
}
