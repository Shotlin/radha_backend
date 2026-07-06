import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { GrnItemRow, NewGrnItem, grnItems } from '@/db/schema/grn';

/**
 * BE-26 — `grn_items` data access.
 *
 * Items inherit their tenant + store ids from the parent header at
 * insert time. We never query items without first scoping by `grnId`
 * (the controller path always carries the GRN id), so the only public
 * filter here is `grnId`.
 */
@Injectable()
export class GrnItemsRepository extends BaseRepository<
  typeof grnItems,
  GrnItemRow,
  NewGrnItem,
  Partial<NewGrnItem>
> {
  constructor(db: DbService) {
    super(db.getDb(), grnItems, 'grn_items');
  }

  async findByGrn(grnId: string, tx?: Transaction): Promise<GrnItemRow[]> {
    const scope = tx ?? this.db;
    return (await scope
      .select()
      .from(grnItems)
      .where(eq(grnItems.grnId, grnId))
      .orderBy(asc(grnItems.createdAt))) as GrnItemRow[];
  }

  async findByIdInGrn(id: string, grnId: string): Promise<GrnItemRow | null> {
    const [row] = await this.db
      .select()
      .from(grnItems)
      .where(and(eq(grnItems.id, id), eq(grnItems.grnId, grnId)))
      .limit(1);
    return (row as GrnItemRow | undefined) ?? null;
  }

  async deleteForGrn(id: string, grnId: string, tx?: Transaction): Promise<boolean> {
    const scope = tx ?? this.db;
    const rows = await scope
      .delete(grnItems)
      .where(and(eq(grnItems.id, id), eq(grnItems.grnId, grnId)))
      .returning({ id: grnItems.id });
    return rows.length > 0;
  }
}
