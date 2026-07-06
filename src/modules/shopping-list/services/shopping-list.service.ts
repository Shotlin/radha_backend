import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import type { ShoppingListItemRow, ShoppingListRow } from '@/db/schema/shopping-lists';

import type { AddShoppingListItemDto, UpdateShoppingListItemDto } from '../dto/add-item.dto';
import type { CreateShoppingListDto, UpdateShoppingListDto } from '../dto/create-list.dto';
import type { WhatsAppFormatDto, WhatsAppFormatResponseDto } from '../dto/whatsapp-format.dto';
import { ShoppingListItemRepository } from '../repositories/shopping-list-item.repository';
import { ShoppingListRepository } from '../repositories/shopping-list.repository';
import { WhatsAppFormatterService } from './whatsapp-formatter.service';

/**
 * BE-55 — Shopping List service.
 *
 * Owns:
 *   - List CRUD (create / list / get / rename / archive).
 *   - Item CRUD (add / update / soft-delete) with the per-list cap of
 *     100 active items enforced on insert.
 *   - WhatsApp share formatting via `WhatsAppFormatterService`.
 *
 * Every read/write is scoped by `userId`; cross-user access is
 * impossible because the repository helpers either filter on
 * `user_id` directly (lists) or chain through the parent list
 * lookup (items).
 */

/** Per-list active-item cap per the BE-55 spec. */
export const MAX_ITEMS_PER_LIST = 100;

export interface ShoppingListSummaryDto {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ShoppingListItemDto {
  id: string;
  listId: string;
  item: string;
  quantity: string | null;
  notes: string | null;
  isPurchased: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShoppingListDetailDto extends ShoppingListSummaryDto {
  items: ShoppingListItemDto[];
}

@Injectable()
export class ShoppingListService {
  private readonly logger = new Logger(ShoppingListService.name);

  constructor(
    private readonly lists: ShoppingListRepository,
    private readonly items: ShoppingListItemRepository,
    private readonly formatter: WhatsAppFormatterService,
  ) {}

  /* ───────────── Lists ───────────── */

  /** Create a new list owned by `userId`. */
  async createList(userId: string, dto: CreateShoppingListDto): Promise<ShoppingListSummaryDto> {
    const row = await this.lists.create({
      userId,
      // `undefined` lets the DB default ("My Shopping List") win.
      name: dto.name ?? undefined,
    });
    this.logger.log(`Shopping list created: ${row.id} for user ${userId}`);
    return this.toListSummary(row);
  }

  /** List the caller's non-archived lists, newest first. */
  async listForUser(userId: string): Promise<ShoppingListSummaryDto[]> {
    const rows = await this.lists.findActiveByUser(userId);
    return rows.map((row) => this.toListSummary(row));
  }

  /**
   * Fetch a single list with its active (non-deleted) items. Throws
   * `NotFoundException` when the list is missing or owned by someone
   * else — we deliberately don't differentiate so we don't leak the
   * existence of sibling users' lists.
   */
  async getListWithItems(listId: string, userId: string): Promise<ShoppingListDetailDto> {
    const list = await this.requireOwnedList(listId, userId);
    const itemRows = await this.items.findActiveByList(listId);
    return {
      ...this.toListSummary(list),
      items: itemRows.map((row) => this.toItemDto(row)),
    };
  }

  /**
   * Rename and/or archive a list. Returns the updated row. Refuses
   * to mutate someone else's list (404).
   */
  async updateList(
    listId: string,
    userId: string,
    dto: UpdateShoppingListDto,
  ): Promise<ShoppingListSummaryDto> {
    await this.requireOwnedList(listId, userId);

    const updated = await this.lists.update(listId, userId, {
      name: dto.name,
      archived: dto.archived,
    });
    if (!updated) {
      // The ownership check passed but the update found nothing —
      // somebody must have raced a delete between the two calls.
      throw new NotFoundException('Shopping list not found');
    }
    return this.toListSummary(updated);
  }

  /* ───────────── Items ───────────── */

  /**
   * Append (or insert at `position`) a new item. Enforces the 100-
   * item-per-list cap per the BE-55 spec.
   */
  async addItem(
    listId: string,
    userId: string,
    dto: AddShoppingListItemDto,
  ): Promise<ShoppingListItemDto> {
    await this.requireActiveList(listId, userId);

    const active = await this.items.countActiveForList(listId);
    if (active >= MAX_ITEMS_PER_LIST) {
      throw new ConflictException(
        `Shopping list is full (max ${MAX_ITEMS_PER_LIST} items). Remove an item before adding another.`,
      );
    }

    const position = dto.position ?? (await this.items.maxPositionForList(listId)) + 1;

    const row = await this.items.create({
      listId,
      item: dto.item,
      quantity: dto.quantity ?? null,
      notes: dto.notes ?? null,
      position,
    });
    await this.lists.touch(listId);
    return this.toItemDto(row);
  }

  /**
   * Update an item — toggle purchased, edit text/quantity/notes, or
   * reorder. Validates the item belongs to the user's list.
   */
  async updateItem(
    listId: string,
    itemId: string,
    userId: string,
    dto: UpdateShoppingListItemDto,
  ): Promise<ShoppingListItemDto> {
    await this.requireActiveList(listId, userId);

    const existing = await this.items.findActiveById(itemId, listId);
    if (!existing) {
      throw new NotFoundException('Shopping list item not found');
    }

    const updated = await this.items.update(itemId, listId, {
      item: dto.item,
      quantity: dto.quantity,
      notes: dto.notes,
      isPurchased: dto.isPurchased,
      position: dto.position,
    });
    if (!updated) {
      throw new NotFoundException('Shopping list item not found');
    }
    await this.lists.touch(listId);
    return this.toItemDto(updated);
  }

  /**
   * Soft-delete an item. Repeated calls on the same item return
   * `NotFoundException` so the client can detect a no-op (e.g. when
   * undo races a sync).
   */
  async deleteItem(
    listId: string,
    itemId: string,
    userId: string,
  ): Promise<{ id: string; deleted: true }> {
    await this.requireActiveList(listId, userId);

    const tombstoned = await this.items.softDelete(itemId, listId);
    if (!tombstoned) {
      throw new NotFoundException('Shopping list item not found');
    }
    await this.lists.touch(listId);
    return { id: itemId, deleted: true };
  }

  /* ───────────── WhatsApp share ───────────── */

  /**
   * Format the list for WhatsApp share. Refuses to format an archived
   * list — sharing a stale list is almost always a user mistake; the
   * client should unarchive first.
   */
  async formatForWhatsApp(
    listId: string,
    userId: string,
    dto: WhatsAppFormatDto,
  ): Promise<WhatsAppFormatResponseDto> {
    const list = await this.requireOwnedList(listId, userId);
    if (list.archivedAt) {
      throw new BadRequestException('Cannot share an archived shopping list');
    }
    const items = await this.items.findActiveByList(listId);
    return this.formatter.format(list, items, {
      includePurchased: dto?.includePurchased,
      phone: dto?.phone,
    });
  }

  /* ───────────── Internal helpers ───────────── */

  /**
   * Return the list row when the caller owns it, else throw 404.
   * Includes archived lists so callers (`updateList`) can unarchive.
   */
  private async requireOwnedList(listId: string, userId: string): Promise<ShoppingListRow> {
    const list = await this.lists.findByIdForUser(listId, userId);
    if (!list) {
      throw new NotFoundException('Shopping list not found');
    }
    return list;
  }

  /**
   * Like `requireOwnedList` but rejects archived lists — used by the
   * item write paths so we never silently mutate an archived list.
   */
  private async requireActiveList(listId: string, userId: string): Promise<ShoppingListRow> {
    const list = await this.requireOwnedList(listId, userId);
    if (list.archivedAt) {
      throw new BadRequestException('Shopping list is archived');
    }
    return list;
  }

  private toListSummary(row: ShoppingListRow): ShoppingListSummaryDto {
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    };
  }

  private toItemDto(row: ShoppingListItemRow): ShoppingListItemDto {
    return {
      id: row.id,
      listId: row.listId,
      item: row.item,
      quantity: row.quantity ?? null,
      notes: row.notes ?? null,
      isPurchased: row.isPurchased,
      position: row.position,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
