import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { encodeCursor, decodeCursor } from '@/db/repositories/pagination.utils';
import {
  SavedProductInsert,
  SavedProductRow,
  savedProducts,
} from '@/db/schema/saved-products';

/** Cursor pagination params consumed by `listByUser`. */
export interface ListSavedProductsCursor {
  cursor?: string;
  limit?: number;
}

/** Page of rows returned by `listByUser`. */
export interface SavedProductPage {
  items: SavedProductRow[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * BE — `saved_products` Drizzle repository.
 *
 * Pure data access — no business logic, no DTO mapping. Every read
 * and write filters on `userId`; the service layer is responsible
 * for sourcing `userId` from the authenticated principal (never
 * from the request body) before calling these helpers.
 *
 * NOTE — the on-disk `saved_products` table (created by migration
 * `0011_be38_saved_products_expiry.sql`) does not carry a
 * `deleted_at` column. We therefore hard-delete rows here. If a
 * future migration introduces soft-delete, change `delete()` to
 * stamp `deletedAt` and add an `isNull(savedProducts.deletedAt)`
 * filter to every read in this file.
 */
@Injectable()
export class SavedProductsRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Cursor-paginated list of the user's saved products, ordered by
   * `(created_at desc, id desc)` to match the existing dashboard
   * convention. `limit` is clamped to `[1, 50]` (default 20).
   */
  async listByUser(userId: string, params: ListSavedProductsCursor): Promise<SavedProductPage> {
    const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const conditions = [eq(savedProducts.userId, userId)];

    if (params.cursor) {
      const decoded = decodeCursor(params.cursor);
      if (decoded && typeof decoded.createdAt === 'string' && typeof decoded.id === 'string') {
        // Composite cursor — `(createdAt, id) < (cursor.createdAt, cursor.id)`
        // matches the `desc, desc` ordering and is index-friendly.
        conditions.push(
          sql`(${savedProducts.createdAt}, ${savedProducts.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id}::uuid)`,
        );
      }
    }

    const rows = (await this.db
      .getDb()
      .select()
      .from(savedProducts)
      .where(and(...conditions))
      .orderBy(desc(savedProducts.createdAt), desc(savedProducts.id))
      .limit(limit + 1)) as SavedProductRow[];

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id }, [
            { field: 'createdAt', direction: 'desc' },
            { field: 'id', direction: 'desc' },
          ])
        : null;

    return { items, nextCursor };
  }

  /**
   * Find a single saved product by id, scoped to its owner. Returns
   * `undefined` when the row is missing or owned by another user —
   * callers translate both into a 404 so we don't leak existence
   * across users.
   */
  async findByIdForUser(id: string, userId: string): Promise<SavedProductRow | undefined> {
    const rows = await this.db
      .getDb()
      .select()
      .from(savedProducts)
      .where(and(eq(savedProducts.id, id), eq(savedProducts.userId, userId)))
      .limit(1);
    return rows[0];
  }

  /** Insert a new saved product row and return it. */
  async create(insert: SavedProductInsert): Promise<SavedProductRow> {
    const rows = await this.db.getDb().insert(savedProducts).values(insert).returning();
    return rows[0];
  }

  /**
   * Delete a saved product owned by `userId`. Returns the number of
   * rows removed (`0` ⇒ row missing or owned by someone else).
   *
   * Hard delete — the table has no `deleted_at` column today (see
   * the class doc-block).
   */
  async delete(id: string, userId: string): Promise<number> {
    const rows = await this.db
      .getDb()
      .delete(savedProducts)
      .where(and(eq(savedProducts.id, id), eq(savedProducts.userId, userId)))
      .returning({ id: savedProducts.id });
    return rows.length;
  }
}
