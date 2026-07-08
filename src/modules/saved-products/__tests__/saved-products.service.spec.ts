import { DomainNotFoundException } from '@/common/errors/business.exception';
import type { SavedProductRow } from '@/db/schema/saved-products';

import type { CreateSavedProductDto } from '../dto/create-saved-product.dto';
import type {
  SavedProductPage,
  SavedProductsRepository,
} from '../saved-products.repository';
import { SavedProductsService } from '../saved-products.service';

/**
 * `SavedProductsService` smoke tests.
 *
 * Covers the contract the FE-16 mobile screen relies on:
 *   - `list`   maps repository rows + cursor into the locked
 *              response shape (`{ items, nextCursor }`).
 *   - `create` projects DTO input to a repository insert and
 *              returns the row mapped through `toDto`.
 *   - `delete` translates a 0-row repository result into a
 *              `DomainNotFoundException` (404 with stable code).
 *
 * The repository is fully mocked — no Drizzle / Postgres in scope.
 */
describe('SavedProductsService', () => {
  type RepoMock = jest.Mocked<SavedProductsRepository>;

  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const otherUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const productId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const rowId = '11111111-1111-4111-8111-111111111111';

  const buildRow = (overrides: Partial<SavedProductRow> = {}): SavedProductRow => ({
    id: rowId,
    userId,
    productName: 'Amul Milk 1L',
    productId: null,
    barcode: null,
    expiresAt: '2026-01-15',
    markedConsumedAt: null,
    notes: null,
    createdAt: new Date('2026-01-01T10:00:00Z'),
    updatedAt: new Date('2026-01-01T10:00:00Z'),
    ...overrides,
  });

  const makeService = (): { service: SavedProductsService; repo: RepoMock } => {
    const repo: RepoMock = {
      listByUser: jest.fn(),
      findByIdForUser: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    } as unknown as RepoMock;

    return { service: new SavedProductsService(repo), repo };
  };

  /* ───────────── list ───────────── */

  describe('list', () => {
    it('forwards cursor + limit to the repository and shapes the response', async () => {
      const { service, repo } = makeService();
      const page: SavedProductPage = {
        items: [buildRow(), buildRow({ id: '22222222-2222-4222-8222-222222222222' })],
        nextCursor: 'opaque-next-cursor',
      };
      repo.listByUser.mockResolvedValue(page);

      const result = await service.list(userId, { cursor: 'in-cursor', limit: 10 });

      expect(repo.listByUser).toHaveBeenCalledWith(userId, {
        cursor: 'in-cursor',
        limit: 10,
      });
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        id: rowId,
        userId,
        productName: 'Amul Milk 1L',
        expiresAt: '2026-01-15',
        markedConsumedAt: null,
      });
      expect(result.nextCursor).toBe('opaque-next-cursor');
    });

    it('returns nextCursor=null on the final page', async () => {
      const { service, repo } = makeService();
      repo.listByUser.mockResolvedValue({ items: [buildRow()], nextCursor: null });

      const result = await service.list(userId, {});

      expect(result.nextCursor).toBeNull();
    });

    it('serialises Date expiresAt values as YYYY-MM-DD', async () => {
      const { service, repo } = makeService();
      // Some Drizzle drivers materialise `date` columns as Date in tests.
      const rowWithDate = buildRow({
        expiresAt: new Date('2026-03-04T00:00:00Z') as unknown as string,
      });
      repo.listByUser.mockResolvedValue({ items: [rowWithDate], nextCursor: null });

      const result = await service.list(userId, {});

      expect(result.items[0].expiresAt).toBe('2026-03-04');
    });
  });

  /* ───────────── create ───────────── */

  describe('create', () => {
    it('passes only the locked fields to the repository', async () => {
      const { service, repo } = makeService();
      const input: CreateSavedProductDto = {
        productName: 'Britannia Bread',
        productId,
        barcode: '8901063012345',
        expiresAt: '2026-02-10',
        notes: 'Whole wheat',
      };
      repo.create.mockResolvedValue(
        buildRow({
          productName: 'Britannia Bread',
          productId,
          barcode: '8901063012345',
          expiresAt: '2026-02-10',
          notes: 'Whole wheat',
        }),
      );

      const result = await service.create(userId, input);

      expect(repo.create).toHaveBeenCalledWith({
        userId,
        productName: 'Britannia Bread',
        productId,
        barcode: '8901063012345',
        expiresAt: '2026-02-10',
        notes: 'Whole wheat',
      });
      expect(result.userId).toBe(userId);
      expect(result.productName).toBe('Britannia Bread');
    });

    it('coerces missing optional fields to null', async () => {
      const { service, repo } = makeService();
      repo.create.mockResolvedValue(buildRow());

      await service.create(userId, { productName: 'Amul Milk 1L' });

      expect(repo.create).toHaveBeenCalledWith({
        userId,
        productName: 'Amul Milk 1L',
        productId: null,
        barcode: null,
        expiresAt: null,
        notes: null,
      });
    });

    it('returns timestamps as ISO strings', async () => {
      const { service, repo } = makeService();
      repo.create.mockResolvedValue(
        buildRow({
          createdAt: new Date('2026-04-05T06:07:08.000Z'),
          updatedAt: new Date('2026-04-05T06:07:08.000Z'),
        }),
      );

      const result = await service.create(userId, { productName: 'X' });

      expect(result.createdAt).toBe('2026-04-05T06:07:08.000Z');
      expect(result.updatedAt).toBe('2026-04-05T06:07:08.000Z');
    });
  });

  /* ───────────── delete ───────────── */

  describe('delete', () => {
    it('asks the repository to delete by (id, userId)', async () => {
      const { service, repo } = makeService();
      repo.delete.mockResolvedValue(1);

      await expect(service.delete(userId, rowId)).resolves.toBeUndefined();

      expect(repo.delete).toHaveBeenCalledWith(rowId, userId);
    });

    it('throws DomainNotFoundException when the repository returns 0 rows', async () => {
      const { service, repo } = makeService();
      repo.delete.mockResolvedValue(0);

      await expect(service.delete(userId, rowId)).rejects.toBeInstanceOf(
        DomainNotFoundException,
      );
    });

    it('treats cross-user attempts as 404 (no leakage)', async () => {
      const { service, repo } = makeService();
      // Repo returns 0 because the row exists but is owned by `userId`,
      // not `otherUserId`. The service must surface a NotFound either way.
      repo.delete.mockResolvedValue(0);

      await expect(service.delete(otherUserId, rowId)).rejects.toBeInstanceOf(
        DomainNotFoundException,
      );
      expect(repo.delete).toHaveBeenCalledWith(rowId, otherUserId);
    });
  });
});
