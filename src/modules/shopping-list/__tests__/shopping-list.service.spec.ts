import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import type { ShoppingListItemRow, ShoppingListRow } from '@/db/schema/shopping-lists';

import type { ShoppingListItemRepository } from '../repositories/shopping-list-item.repository';
import type { ShoppingListRepository } from '../repositories/shopping-list.repository';
import { MAX_ITEMS_PER_LIST, ShoppingListService } from '../services/shopping-list.service';
import { WhatsAppFormatterService } from '../services/whatsapp-formatter.service';

/**
 * BE-55 — `ShoppingListService` unit tests.
 *
 * Exercises the contract the BE-55 spec promises:
 *   - CRUD on lists (create, list, get, rename, archive),
 *   - Item add/update/soft-delete with the 100-item-per-list cap,
 *   - Ownership scoping (404 on cross-user access),
 *   - WhatsApp formatting wiring + archive guard,
 *   - parent-list `updated_at` is touched on item mutations.
 */
describe('ShoppingListService', () => {
  type ListRepoMock = jest.Mocked<ShoppingListRepository>;
  type ItemRepoMock = jest.Mocked<ShoppingListItemRepository>;

  const userId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const otherUserId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const listId = '11111111-1111-1111-1111-111111111111';
  const itemId = '22222222-2222-2222-2222-222222222222';

  const buildListRow = (overrides: Partial<ShoppingListRow> = {}): ShoppingListRow => ({
    id: listId,
    userId,
    name: 'My Shopping List',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    archivedAt: null,
    ...overrides,
  });

  const buildItemRow = (overrides: Partial<ShoppingListItemRow> = {}): ShoppingListItemRow => ({
    id: itemId,
    listId,
    item: 'Milk',
    quantity: '2L',
    notes: null,
    isPurchased: false,
    position: 0,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  });

  const makeService = (): {
    service: ShoppingListService;
    listRepo: ListRepoMock;
    itemRepo: ItemRepoMock;
    formatter: WhatsAppFormatterService;
  } => {
    const listRepo: ListRepoMock = {
      create: jest.fn(),
      findByIdForUser: jest.fn(),
      findActiveByUser: jest.fn(),
      update: jest.fn(),
      touch: jest.fn(),
      countActiveByUser: jest.fn(),
    } as unknown as ListRepoMock;

    const itemRepo: ItemRepoMock = {
      countActiveForList: jest.fn(),
      findActiveById: jest.fn(),
      findActiveByList: jest.fn(),
      maxPositionForList: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
    } as unknown as ItemRepoMock;

    const formatter = new WhatsAppFormatterService();
    const service = new ShoppingListService(listRepo, itemRepo, formatter);
    return { service, listRepo, itemRepo, formatter };
  };

  /* ───────────── createList ───────────── */

  describe('createList', () => {
    it('persists a new list and returns the summary', async () => {
      const { service, listRepo } = makeService();
      const row = buildListRow({ name: 'Diwali Shopping' });
      listRepo.create.mockResolvedValue(row);

      const result = await service.createList(userId, { name: 'Diwali Shopping' });

      expect(listRepo.create).toHaveBeenCalledWith({ userId, name: 'Diwali Shopping' });
      expect(result).toMatchObject({
        id: listId,
        userId,
        name: 'Diwali Shopping',
        archivedAt: null,
      });
    });

    it('lets the DB default supply the name when omitted', async () => {
      const { service, listRepo } = makeService();
      listRepo.create.mockResolvedValue(buildListRow());

      await service.createList(userId, {});

      expect(listRepo.create).toHaveBeenCalledWith({ userId, name: undefined });
    });
  });

  /* ───────────── listForUser ───────────── */

  describe('listForUser', () => {
    it('returns the active lists in summary form', async () => {
      const { service, listRepo } = makeService();
      listRepo.findActiveByUser.mockResolvedValue([buildListRow(), buildListRow({ id: 'l2' })]);

      const result = await service.listForUser(userId);

      expect(listRepo.findActiveByUser).toHaveBeenCalledWith(userId);
      expect(result).toHaveLength(2);
    });
  });

  /* ───────────── getListWithItems ───────────── */

  describe('getListWithItems', () => {
    it('returns the list with its active items', async () => {
      const { service, listRepo, itemRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(buildListRow());
      itemRepo.findActiveByList.mockResolvedValue([buildItemRow(), buildItemRow({ id: 'i2' })]);

      const result = await service.getListWithItems(listId, userId);

      expect(result.items).toHaveLength(2);
      expect(result.id).toBe(listId);
    });

    it('throws NotFound when the list belongs to someone else', async () => {
      const { service, listRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(null);

      await expect(service.getListWithItems(listId, otherUserId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  /* ───────────── updateList ───────────── */

  describe('updateList', () => {
    it('renames a list', async () => {
      const { service, listRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(buildListRow());
      listRepo.update.mockResolvedValue(buildListRow({ name: 'Renamed' }));

      const result = await service.updateList(listId, userId, { name: 'Renamed' });

      expect(listRepo.update).toHaveBeenCalledWith(listId, userId, {
        name: 'Renamed',
        archived: undefined,
      });
      expect(result.name).toBe('Renamed');
    });

    it('archives a list', async () => {
      const { service, listRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(buildListRow());
      const archivedAt = new Date('2024-02-01T00:00:00Z');
      listRepo.update.mockResolvedValue(buildListRow({ archivedAt }));

      const result = await service.updateList(listId, userId, { archived: true });

      expect(listRepo.update).toHaveBeenCalledWith(listId, userId, {
        name: undefined,
        archived: true,
      });
      expect(result.archivedAt).toBe(archivedAt.toISOString());
    });

    it('throws NotFound when ownership check fails', async () => {
      const { service, listRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(null);

      await expect(service.updateList(listId, userId, { name: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  /* ───────────── addItem ───────────── */

  describe('addItem', () => {
    it('appends a new item to the end when no position is given', async () => {
      const { service, listRepo, itemRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(buildListRow());
      itemRepo.countActiveForList.mockResolvedValue(3);
      itemRepo.maxPositionForList.mockResolvedValue(2);
      itemRepo.create.mockResolvedValue(buildItemRow({ position: 3 }));

      const result = await service.addItem(listId, userId, { item: 'Milk', quantity: '2L' });

      expect(itemRepo.create).toHaveBeenCalledWith({
        listId,
        item: 'Milk',
        quantity: '2L',
        notes: null,
        position: 3,
      });
      expect(listRepo.touch).toHaveBeenCalledWith(listId);
      expect(result.position).toBe(3);
    });

    it('honours an explicit position', async () => {
      const { service, listRepo, itemRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(buildListRow());
      itemRepo.countActiveForList.mockResolvedValue(1);
      itemRepo.create.mockResolvedValue(buildItemRow({ position: 0 }));

      await service.addItem(listId, userId, { item: 'Bread', position: 0 });

      expect(itemRepo.maxPositionForList).not.toHaveBeenCalled();
      expect(itemRepo.create).toHaveBeenCalledWith({
        listId,
        item: 'Bread',
        quantity: null,
        notes: null,
        position: 0,
      });
    });

    it(`rejects new items past the ${MAX_ITEMS_PER_LIST}-item cap`, async () => {
      const { service, listRepo, itemRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(buildListRow());
      itemRepo.countActiveForList.mockResolvedValue(MAX_ITEMS_PER_LIST);

      await expect(service.addItem(listId, userId, { item: 'Eggs' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(itemRepo.create).not.toHaveBeenCalled();
    });

    it('refuses to add to an archived list', async () => {
      const { service, listRepo, itemRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(buildListRow({ archivedAt: new Date() }));

      await expect(service.addItem(listId, userId, { item: 'Eggs' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(itemRepo.create).not.toHaveBeenCalled();
    });
  });

  /* ───────────── updateItem ───────────── */

  describe('updateItem', () => {
    it('toggles isPurchased and touches the parent list', async () => {
      const { service, listRepo, itemRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(buildListRow());
      itemRepo.findActiveById.mockResolvedValue(buildItemRow());
      itemRepo.update.mockResolvedValue(buildItemRow({ isPurchased: true }));

      const result = await service.updateItem(listId, itemId, userId, { isPurchased: true });

      // Repository signature is (id, listId, patch).
      expect(itemRepo.update).toHaveBeenCalledWith(itemId, listId, {
        item: undefined,
        quantity: undefined,
        notes: undefined,
        isPurchased: true,
        position: undefined,
      });
      expect(listRepo.touch).toHaveBeenCalledWith(listId);
      expect(result.isPurchased).toBe(true);
    });

    it('passes through nullable quantity/notes clears', async () => {
      const { service, listRepo, itemRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(buildListRow());
      itemRepo.findActiveById.mockResolvedValue(buildItemRow());
      itemRepo.update.mockResolvedValue(buildItemRow({ quantity: null, notes: null }));

      await service.updateItem(listId, itemId, userId, { quantity: null, notes: null });

      expect(itemRepo.update).toHaveBeenCalledWith(itemId, listId, {
        item: undefined,
        quantity: null,
        notes: null,
        isPurchased: undefined,
        position: undefined,
      });
    });

    it('throws NotFound when the item is missing or already deleted', async () => {
      const { service, listRepo, itemRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(buildListRow());
      itemRepo.findActiveById.mockResolvedValue(null);

      await expect(
        service.updateItem(listId, itemId, userId, { isPurchased: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(itemRepo.update).not.toHaveBeenCalled();
    });

    it('refuses to update items on an archived list', async () => {
      const { service, listRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(buildListRow({ archivedAt: new Date() }));

      await expect(
        service.updateItem(listId, itemId, userId, { isPurchased: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  /* ───────────── deleteItem ───────────── */

  describe('deleteItem', () => {
    it('soft-deletes an item and touches the list', async () => {
      const { service, listRepo, itemRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(buildListRow());
      itemRepo.softDelete.mockResolvedValue(buildItemRow({ deletedAt: new Date() }));

      const result = await service.deleteItem(listId, itemId, userId);

      expect(itemRepo.softDelete).toHaveBeenCalledWith(itemId, listId);
      expect(listRepo.touch).toHaveBeenCalledWith(listId);
      expect(result).toEqual({ id: itemId, deleted: true });
    });

    it('throws NotFound when the item is already gone', async () => {
      const { service, listRepo, itemRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(buildListRow());
      itemRepo.softDelete.mockResolvedValue(null);

      await expect(service.deleteItem(listId, itemId, userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  /* ───────────── formatForWhatsApp ───────────── */

  describe('formatForWhatsApp', () => {
    it('produces text + shareUrl using the formatter', async () => {
      const { service, listRepo, itemRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(buildListRow({ name: 'My List' }));
      itemRepo.findActiveByList.mockResolvedValue([
        buildItemRow({ item: 'Milk', quantity: '2L' }),
        buildItemRow({ id: 'i2', item: 'Bread', quantity: null }),
      ]);

      const result = await service.formatForWhatsApp(listId, userId, undefined);

      expect(result.text).toBe('My List\n- Milk (2L)\n- Bread');
      expect(result.shareUrl).toBe(`https://wa.me/?text=${encodeURIComponent(result.text)}`);
    });

    it('refuses to format an archived list', async () => {
      const { service, listRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(buildListRow({ archivedAt: new Date() }));

      await expect(service.formatForWhatsApp(listId, userId, undefined)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws NotFound when the list belongs to someone else', async () => {
      const { service, listRepo } = makeService();
      listRepo.findByIdForUser.mockResolvedValue(null);

      await expect(
        service.formatForWhatsApp(listId, otherUserId, undefined),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('passes includePurchased and phone options through to the formatter', async () => {
      const { service, listRepo, itemRepo, formatter } = makeService();
      const formatSpy = jest.spyOn(formatter, 'format');
      listRepo.findByIdForUser.mockResolvedValue(buildListRow());
      itemRepo.findActiveByList.mockResolvedValue([buildItemRow({ quantity: null })]);

      await service.formatForWhatsApp(listId, userId, {
        includePurchased: false,
        phone: '+91 9876543210',
      });

      expect(formatSpy).toHaveBeenCalledWith(expect.anything(), expect.any(Array), {
        includePurchased: false,
        phone: '+91 9876543210',
      });
    });
  });
});
