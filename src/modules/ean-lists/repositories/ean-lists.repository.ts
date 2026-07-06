import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { EanListRow, NewEanList, eanLists } from '@/db/schema/ean-lists';

@Injectable()
export class EanListsRepository extends BaseRepository<
  typeof eanLists,
  EanListRow,
  NewEanList,
  Partial<NewEanList>
> {
  constructor(db: DbService) {
    super(db.getDb(), eanLists, 'ean_lists');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<EanListRow | null> {
    const [row] = await this.db
      .select()
      .from(eanLists)
      .where(and(eq(eanLists.id, id), eq(eanLists.tenantId, tenantId), isNull(eanLists.deletedAt)))
      .limit(1);
    return (row as EanListRow | undefined) ?? null;
  }

  /**
   * Resolve the active list for a store. Falls back to an active
   * tenant-wide list (`storeId IS NULL`) when no store-specific list
   * exists. Order: store-specific > tenant-wide.
   */
  async findActiveForStore(tenantId: string, storeId: string): Promise<EanListRow | null> {
    const [storeSpecific] = await this.db
      .select()
      .from(eanLists)
      .where(
        and(
          eq(eanLists.tenantId, tenantId),
          eq(eanLists.storeId, storeId),
          eq(eanLists.status, 'active'),
          isNull(eanLists.deletedAt),
        ),
      )
      .orderBy(desc(eanLists.activatedAt))
      .limit(1);
    if (storeSpecific) return storeSpecific as EanListRow;

    const [tenantWide] = await this.db
      .select()
      .from(eanLists)
      .where(
        and(
          eq(eanLists.tenantId, tenantId),
          isNull(eanLists.storeId),
          eq(eanLists.status, 'active'),
          isNull(eanLists.deletedAt),
        ),
      )
      .orderBy(desc(eanLists.activatedAt))
      .limit(1);
    return (tenantWide as EanListRow | undefined) ?? null;
  }

  async deactivateAllForScope(tenantId: string, storeId: string | null): Promise<void> {
    const condition = storeId
      ? and(
          eq(eanLists.tenantId, tenantId),
          eq(eanLists.storeId, storeId),
          eq(eanLists.status, 'active'),
        )
      : and(
          eq(eanLists.tenantId, tenantId),
          isNull(eanLists.storeId),
          eq(eanLists.status, 'active'),
        );
    await this.db
      .update(eanLists)
      .set({ status: 'archived', deactivatedAt: new Date(), updatedAt: new Date() })
      .where(condition);
  }

  async listForTenant(
    tenantId: string,
    filters: { storeId?: string; status?: EanListRow['status'] },
    limit: number,
  ): Promise<EanListRow[]> {
    const conditions = [eq(eanLists.tenantId, tenantId), isNull(eanLists.deletedAt)];
    if (filters.storeId) conditions.push(eq(eanLists.storeId, filters.storeId));
    if (filters.status) conditions.push(eq(eanLists.status, filters.status));
    return (await this.db
      .select()
      .from(eanLists)
      .where(and(...conditions))
      .orderBy(desc(eanLists.createdAt))
      .limit(limit)) as EanListRow[];
  }

  async incrementCounters(
    id: string,
    delta: { totalItems?: number; validatedItems?: number },
  ): Promise<void> {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (delta.totalItems) {
      updates.totalItems = sql`${eanLists.totalItems} + ${delta.totalItems}`;
    }
    if (delta.validatedItems) {
      updates.validatedItems = sql`${eanLists.validatedItems} + ${delta.validatedItems}`;
    }
    await this.db
      .update(eanLists)
      .set(updates as never)
      .where(eq(eanLists.id, id));
  }
}
