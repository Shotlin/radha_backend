import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  NewShoppingListItem,
  shoppingListItems,
  ShoppingListItemRow,
} from '@/db/schema/shopping-lists';

/**
 * BE-55 — Drizzle repository for `shopping_list_items`.
 *
 * Soft-delete-aware: every read filters on `deleted_at IS NULL`. The
 * partial index `idx_shopping_list_items_list` covers the hot read
 * path (`(list_id, position)`).
 */
@Injectable()
export class ShoppingListItemRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Number of non-deleted items on a list. Used by the service layer
   * to enforce the per-list cap of 100 items.
   */
  async countActiveForList(listId: string): Promise<number> {
    const rows = await this.db
      .getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(shoppingListItems)
      .where(and(eq(shoppingListItems.listId, listId), isNull(shoppingListItems.deletedAt)));
    return rows[0]?.count ?? 0;
  }

  /**
   * Find an item by id, scoped to its parent list (and excluding
   * tombstones). Returns `null` when the row is missing or already
   * soft-deleted — callers treat both as not-found.
   */
  async findActiveById(id: string, listId: string): Promise<ShoppingListItemRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(shoppingListItems)
      .where(
        and(
          eq(shoppingListItems.id, id),
          eq(shoppingListItems.listId, listId),
          isNull(shoppingListItems.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** All non-deleted items on a list, ordered by `position`, then created_at. */
  async findActiveByList(listId: string): Promise<ShoppingListItemRow[]> {
    return this.db
      .getDb()
      .select()
      .from(shoppingListItems)
      .where(and(eq(shoppingListItems.listId, listId), isNull(shoppingListItems.deletedAt)))
      .orderBy(asc(shoppingListItems.position), asc(shoppingListItems.createdAt));
  }

  /**
   * Highest `position` currently used on the list. The service uses
   * this to default a new item's position to "append to end". Returns
   * `-1` for an empty list so the next position is `0`.
   */
  async maxPositionForList(listId: string): Promise<number> {
    const rows = await this.db
      .getDb()
      .select({ maxPos: sql<number | null>`max(${shoppingListItems.position})` })
      .from(shoppingListItems)
      .where(and(eq(shoppingListItems.listId, listId), isNull(shoppingListItems.deletedAt)));
    const value = rows[0]?.maxPos;
    return value == null ? -1 : Number(value);
  }

  /** Insert a new item row. */
  async create(data: NewShoppingListItem): Promise<ShoppingListItemRow> {
    const rows = await this.db.getDb().insert(shoppingListItems).values(data).returning();
    return rows[0];
  }

  /**
   * Patch an item. Accepts `null` for `quantity`/`notes` so the
   * caller can clear them. Returns the updated row, or `null` when
   * the row is missing or already soft-deleted.
   */
  async update(
    id: string,
    listId: string,
    patch: {
      item?: string;
      quantity?: string | null;
      notes?: string | null;
      isPurchased?: boolean;
      position?: number;
    },
  ): Promise<ShoppingListItemRow | null> {
    const updates: Partial<ShoppingListItemRow> = { updatedAt: new Date() };
    if (patch.item !== undefined) updates.item = patch.item;
    if (patch.quantity !== undefined) updates.quantity = patch.quantity;
    if (patch.notes !== undefined) updates.notes = patch.notes;
    if (patch.isPurchased !== undefined) updates.isPurchased = patch.isPurchased;
    if (patch.position !== undefined) updates.position = patch.position;

    const rows = await this.db
      .getDb()
      .update(shoppingListItems)
      .set(updates)
      .where(
        and(
          eq(shoppingListItems.id, id),
          eq(shoppingListItems.listId, listId),
          isNull(shoppingListItems.deletedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Soft-delete an item by stamping `deleted_at`. Returns the
   * tombstoned row, or `null` if it was already gone.
   */
  async softDelete(id: string, listId: string): Promise<ShoppingListItemRow | null> {
    const now = new Date();
    const rows = await this.db
      .getDb()
      .update(shoppingListItems)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(shoppingListItems.id, id),
          eq(shoppingListItems.listId, listId),
          isNull(shoppingListItems.deletedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }
}
