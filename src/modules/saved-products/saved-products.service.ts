import { Injectable, Logger } from '@nestjs/common';

import { DomainNotFoundException } from '@/common/errors/business.exception';
import type { SavedProductRow } from '@/db/schema/saved-products';

import type { CreateSavedProductDto } from './dto/create-saved-product.dto';
import type {
  SavedProductDto,
  SavedProductListResponseDto,
} from './dto/saved-product.dto';
import {
  ListSavedProductsCursor,
  SavedProductsRepository,
} from './saved-products.repository';

const RESOURCE = 'SavedProduct';

/**
 * Saved Products — service layer.
 *
 * Owns the business logic for the locked
 * `/api/v1/saved-products` REST surface that powers the FE-16
 * mobile screen. Methods stay narrow:
 *
 *   - `list`    page through the caller's saved products.
 *   - `create`  insert a new row stamped with the authenticated
 *               user's id.
 *   - `delete`  remove a row owned by the caller, throwing 404
 *               when the row is missing or owned by another user.
 *
 * No drizzle / db client imports — every database touch goes
 * through `SavedProductsRepository`.
 *
 * Audit logging is intentionally omitted to mirror the sibling
 * consumer feature `shopping-list/services/shopping-list.service.ts`
 * which also writes to a per-user table without a tenant scope and
 * skips the audit hop. If product wants tamper-evident traces here
 * later, plumb `AuditLogService` through the constructor and call
 * it inside `create` / `delete`.
 */
@Injectable()
export class SavedProductsService {
  private readonly logger = new Logger(SavedProductsService.name);

  constructor(private readonly repo: SavedProductsRepository) {}

  /**
   * Page through the caller's saved products. The repository clamps
   * `limit` to `[1, 50]` (default 20) and emits an opaque cursor;
   * we just project the rows into the DTO shape.
   */
  async list(userId: string, params: ListSavedProductsCursor): Promise<SavedProductListResponseDto> {
    const page = await this.repo.listByUser(userId, params);
    return {
      items: page.items.map((row) => this.toDto(row)),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Insert a new saved product owned by `userId`. We deliberately
   * do not upsert on `(userId, barcode)` — the FE-16 flow lets the
   * user save the same product twice (e.g. two batches with
   * different expiry dates), and the locked contract returns the
   * created row verbatim.
   */
  async create(userId: string, input: CreateSavedProductDto): Promise<SavedProductDto> {
    const row = await this.repo.create({
      userId,
      productName: input.productName,
      productId: input.productId ?? null,
      barcode: input.barcode ?? null,
      expiresAt: input.expiresAt ?? null,
      notes: input.notes ?? null,
    });
    this.logger.log(`Saved product created: ${row.id} (user=${userId})`);
    return this.toDto(row);
  }

  /**
   * Delete a saved product owned by the caller. Throws
   * `DomainNotFoundException` (404 with stable error code) when the
   * row does not exist or belongs to a different user — we treat
   * both cases identically so we don't leak existence across users.
   */
  async delete(userId: string, id: string): Promise<void> {
    const removed = await this.repo.delete(id, userId);
    if (removed === 0) {
      throw new DomainNotFoundException(RESOURCE, id);
    }
    this.logger.log(`Saved product deleted: ${id} (user=${userId})`);
  }

  /**
   * Map a Drizzle row to the locked `SavedProductDto`. `expiresAt`
   * is a Postgres `DATE` and arrives from `postgres-js` as a
   * `YYYY-MM-DD` string; the timestamp columns arrive as `Date`
   * objects which we serialise with `toISOString()`.
   */
  private toDto(row: SavedProductRow): SavedProductDto {
    return {
      id: row.id,
      userId: row.userId,
      productName: row.productName,
      productId: row.productId ?? null,
      barcode: row.barcode ?? null,
      expiresAt: this.serialiseDate(row.expiresAt),
      markedConsumedAt: row.markedConsumedAt
        ? row.markedConsumedAt.toISOString()
        : null,
      notes: row.notes ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Normalise a `DATE` column to `YYYY-MM-DD`. The Drizzle type for
   * a `date()` column is `string | null`, but we defensively also
   * handle `Date` instances for tests that build rows manually.
   */
  private serialiseDate(value: SavedProductRow['expiresAt']): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    return (value as Date).toISOString().split('T')[0];
  }
}
