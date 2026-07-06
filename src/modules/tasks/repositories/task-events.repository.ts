import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewTaskEvent, TaskEventRow, taskEvents } from '@/db/schema/tasks';

/**
 * BE-19 — `task_events` is append-only.
 *
 * Only `create` and `findByTask` are exposed; events never get
 * updated or deleted (cascade-on-task-delete handles cleanup).
 */
@Injectable()
export class TaskEventsRepository extends BaseRepository<
  typeof taskEvents,
  TaskEventRow,
  NewTaskEvent,
  Partial<NewTaskEvent>
> {
  constructor(db: DbService) {
    super(db.getDb(), taskEvents, 'task_events');
  }

  async findByTask(taskId: string, tenantId: string): Promise<TaskEventRow[]> {
    return (await this.db
      .select()
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.tenantId, tenantId)))
      .orderBy(asc(taskEvents.createdAt))) as TaskEventRow[];
  }
}
