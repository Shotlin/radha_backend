import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewTaskTemplate, TaskTemplateRow, taskTemplates } from '@/db/schema/tasks';

import type { TaskType } from '../types/task.types';

/**
 * BE-19 — `task_templates` data access.
 *
 * Templates are tenant-scoped reusable definitions. Soft-delete
 * supported; the partial unique index `(tenant_id, name) WHERE
 * deleted_at IS NULL` makes "create same name after deleting the old
 * one" a clean insert.
 */
@Injectable()
export class TaskTemplatesRepository extends BaseRepository<
  typeof taskTemplates,
  TaskTemplateRow,
  NewTaskTemplate,
  Partial<NewTaskTemplate>
> {
  constructor(db: DbService) {
    super(db.getDb(), taskTemplates, 'task_templates');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<TaskTemplateRow | null> {
    const [row] = await this.db
      .select()
      .from(taskTemplates)
      .where(
        and(
          eq(taskTemplates.id, id),
          eq(taskTemplates.tenantId, tenantId),
          isNull(taskTemplates.deletedAt),
        ),
      )
      .limit(1);
    return (row as TaskTemplateRow | undefined) ?? null;
  }

  async findByNameInTenant(tenantId: string, name: string): Promise<TaskTemplateRow | null> {
    const [row] = await this.db
      .select()
      .from(taskTemplates)
      .where(
        and(
          eq(taskTemplates.tenantId, tenantId),
          eq(taskTemplates.name, name),
          isNull(taskTemplates.deletedAt),
        ),
      )
      .limit(1);
    return (row as TaskTemplateRow | undefined) ?? null;
  }

  async listForTenant(
    tenantId: string,
    filters: { isActive?: boolean; type?: TaskType; limit: number },
  ): Promise<TaskTemplateRow[]> {
    const conds = [eq(taskTemplates.tenantId, tenantId), isNull(taskTemplates.deletedAt)];
    if (filters.isActive !== undefined) {
      conds.push(eq(taskTemplates.isActive, filters.isActive));
    }
    if (filters.type) conds.push(eq(taskTemplates.type, filters.type));

    return (await this.db
      .select()
      .from(taskTemplates)
      .where(and(...conds))
      .orderBy(asc(taskTemplates.name))
      .limit(filters.limit)) as TaskTemplateRow[];
  }
}
