import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { NewShoppingList, shoppingLists, ShoppingListRow } from '@/db/schema/shopping-lists';

/**
 * BE-55 — Drizzle repository for the `shopping_lists` table.
 *
 * Pure data access — no business logic, no formatting. The service
 * layer (`ShoppingListService`) decides who can see which list and
 * delegates here for every read/write.
 */
@Injectable()
export class ShoppingListRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Insert a new list. The DB defaults `name` to "My Shopping List"
   * when the caller omits it, so passing `name: undefined` is valid.
   */
  async create(data: NewShoppingList): Promise<ShoppingListRow> {
    const rows = await this.db.getDb().insert(shoppingLists).values(data).returning();
    return rows[0];
  }

  /**
   * Find a list by id, scoped to its owner. Soft-archived rows are
   * still returned so the caller can decide whether to surface or
   * unarchive them; the active-only listing is `findActiveByUser`.
   */
  async findByIdForUser(id: string, userId: string): Promise<ShoppingListRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(shoppingLists)
      .where(and(eq(shoppingLists.id, id), eq(shoppingLists.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * List the user's non-archived lists, newest first. Powered by the
   * partial index `idx_shopping_lists_user_active`.
   */
  async findActiveByUser(userId: string): Promise<ShoppingListRow[]> {
    return this.db
      .getDb()
      .select()
      .from(shoppingLists)
      .where(and(eq(shoppingLists.userId, userId), isNull(shoppingLists.archivedAt)))
      .orderBy(desc(shoppingLists.createdAt));
  }

  /**
   * Patch the `name` and/or `archived_at` columns.
   *
   *   - `name`        → renames the list.
   *   - `archived`    → `true` archives, `false` unarchives.
   *
   * Returns the updated row, or `null` when no row matched
   * (`id` + `user_id`).
   */
  async update(
    id: string,
    userId: string,
    patch: { name?: string; archived?: boolean },
  ): Promise<ShoppingListRow | null> {
    const updates: Partial<ShoppingListRow> = { updatedAt: new Date() };
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.archived !== undefined) {
      updates.archivedAt = patch.archived ? new Date() : null;
    }

    const rows = await this.db
      .getDb()
      .update(shoppingLists)
      .set(updates)
      .where(and(eq(shoppingLists.id, id), eq(shoppingLists.userId, userId)))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Touch `updated_at` on the parent list. Called by the items
   * repository whenever items mutate so the list-level "last
   * modified" stays meaningful.
   */
  async touch(id: string): Promise<void> {
    await this.db
      .getDb()
      .update(shoppingLists)
      .set({ updatedAt: new Date() })
      .where(eq(shoppingLists.id, id));
  }

  /** Diagnostic: count active lists for a user. */
  async countActiveByUser(userId: string): Promise<number> {
    const rows = await this.db
      .getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(shoppingLists)
      .where(and(eq(shoppingLists.userId, userId), isNull(shoppingLists.archivedAt)));
    return rows[0]?.count ?? 0;
  }
}
