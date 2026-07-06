import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import type { Transaction } from '@/db/connection';
import { EanListItemRow, NewEanListItem, eanListItems } from '@/db/schema/ean-lists';

@Injectable()
export class EanListItemsRepository extends BaseRepository<
  typeof eanListItems,
  EanListItemRow,
  NewEanListItem,
  Partial<NewEanListItem>
> {
  constructor(db: DbService) {
    super(db.getDb(), eanListItems, 'ean_list_items');
  }

  async findByListAndEan(listId: string, ean: string): Promise<EanListItemRow | null> {
    const [row] = await this.db
      .select()
      .from(eanListItems)
      .where(and(eq(eanListItems.listId, listId), eq(eanListItems.ean, ean)))
      .limit(1);
    return (row as EanListItemRow | undefined) ?? null;
  }

  async findManyByListAndEans(listId: string, eans: string[]): Promise<EanListItemRow[]> {
    if (eans.length === 0) return [];
    return (await this.db
      .select()
      .from(eanListItems)
      .where(
        and(eq(eanListItems.listId, listId), inArray(eanListItems.ean, eans)),
      )) as EanListItemRow[];
  }

  /**
   * Insert many items, ignoring `(list_id, ean)` collisions silently —
   * importer policy is "first occurrence wins". This avoids duplicate
   * key errors aborting the entire chunk.
   */
  async bulkInsert(rows: NewEanListItem[], tx?: Transaction): Promise<EanListItemRow[]> {
    if (rows.length === 0) return [];
    const scope = tx ?? this.db;
    return (await scope
      .insert(eanListItems)
      .values(rows)
      .onConflictDoNothing({ target: [eanListItems.listId, eanListItems.ean] })
      .returning()) as EanListItemRow[];
  }

  async countByList(listId: string): Promise<number> {
    return this.count({ listId } as Partial<EanListItemRow>);
  }

  async listByList(listId: string, limit: number): Promise<EanListItemRow[]> {
    return (await this.db
      .select()
      .from(eanListItems)
      .where(eq(eanListItems.listId, listId))
      .limit(limit)) as EanListItemRow[];
  }
}
