import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { GrnEventRow, NewGrnEvent, grnEvents } from '@/db/schema/grn';

/**
 * BE-26 — `grn_events` is append-only.
 *
 * Only `create` and `findByGrn` are exposed; events never get
 * updated or deleted (the cascade on grn header deletion handles
 * cleanup if a draft is ever hard-deleted).
 */
@Injectable()
export class GrnEventsRepository extends BaseRepository<
  typeof grnEvents,
  GrnEventRow,
  NewGrnEvent,
  Partial<NewGrnEvent>
> {
  constructor(db: DbService) {
    super(db.getDb(), grnEvents, 'grn_events');
  }

  async findByGrn(grnId: string, tenantId: string): Promise<GrnEventRow[]> {
    return (await this.db
      .select()
      .from(grnEvents)
      .where(and(eq(grnEvents.grnId, grnId), eq(grnEvents.tenantId, tenantId)))
      .orderBy(asc(grnEvents.createdAt))) as GrnEventRow[];
  }
}
