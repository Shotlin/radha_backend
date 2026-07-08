/**
 * `SavedProductsRepository` minimal mock-db tests.
 *
 * The Drizzle query builder is heavily chained (`select().from().
 * where().orderBy().limit()`), so a full SQL-emitting fake would
 * require a real driver. Instead we replace the Drizzle helper
 * functions (`eq`, `and`, `desc`, `sql`) with `jest.fn()` markers
 * so we can assert two things the brief requires:
 *
 *   1. Every read scoped to `userId` calls `eq(savedProducts.userId,
 *      <id>)` (proving the WHERE clause includes `userId`).
 *   2. `delete()` filters on both `id` and `userId`.
 *
 * The chainable `db` fake just returns itself from every method so
 * the repository can complete its chain without crashing.
 */

// `jest.mock` calls are hoisted above the imports, so the factory
// can't close over local variables. Wire the spies through the
// global object instead — accessed once via `getDrizzleSpies()`
// below and stable across the test run.
jest.mock('drizzle-orm', () => {
  const eq = jest.fn((column: unknown, value: unknown) => ({ kind: 'eq', column, value }));
  const and = jest.fn((...args: unknown[]) => ({ kind: 'and', args }));
  const desc = jest.fn((column: unknown) => ({ kind: 'desc', column }));
  const sql = Object.assign(
    (..._args: unknown[]) => ({ kind: 'sql' }),
    { raw: (s: string) => ({ kind: 'sql.raw', s }) },
  );
  // Stash the spies so the test file can inspect them.
  (globalThis as Record<string, unknown>).__drizzleSpies = { eq, and, desc, sql };
  return { __esModule: true, eq, and, desc, sql };
});

// Stub the cursor codec so the repo can run without real base64
// round-tripping. `decodeCursor` returns a fixed valid cursor when
// called with the sentinel `VALID_CURSOR`, otherwise null.
jest.mock('@/db/repositories/pagination.utils', () => ({
  __esModule: true,
  encodeCursor: jest.fn(() => 'ENCODED_CURSOR'),
  decodeCursor: jest.fn((cursor: string) =>
    cursor === 'VALID_CURSOR'
      ? {
          createdAt: '2026-01-01T00:00:00.000Z',
          id: '11111111-1111-4111-8111-111111111111',
        }
      : null,
  ),
}));

// eslint-disable-next-line import/order
import { SavedProductsRepository } from '../saved-products.repository';

interface DrizzleSpies {
  eq: jest.Mock;
  and: jest.Mock;
  desc: jest.Mock;
}

const getDrizzleSpies = (): DrizzleSpies =>
  (globalThis as unknown as { __drizzleSpies: DrizzleSpies }).__drizzleSpies;

describe('SavedProductsRepository', () => {
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const otherUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const rowId = '22222222-2222-4222-8222-222222222222';

  // Drizzle's actual schema object — imported lazily to avoid the
  // jest hoisting trap (`drizzle-orm` is mocked above).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { savedProducts } = require('@/db/schema/saved-products');

  // Build a chainable Drizzle fake. Each method returns the same
  // object so `.select().from().where().orderBy().limit()` resolves
  // without errors. `then` makes the final value awaitable.
  const buildChain = (resolveTo: unknown) => {
    const self: Record<string, unknown> = {};
    const chain: Record<string, jest.Mock> = {};
    for (const m of [
      'select',
      'from',
      'where',
      'orderBy',
      'limit',
      'insert',
      'values',
      'returning',
      'delete',
    ]) {
      chain[m] = jest.fn(() => self);
      self[m] = chain[m];
    }
    self.then = (resolve: (v: unknown) => void) => Promise.resolve(resolveTo).then(resolve);
    return { self, chain };
  };

  const buildRepo = (resolveTo: unknown) => {
    const { self, chain } = buildChain(resolveTo);
    const db = { getDb: () => self };
    const repo = new SavedProductsRepository(db as never);
    return { repo, chain };
  };

  beforeEach(() => {
    const spies = getDrizzleSpies();
    spies.eq.mockClear();
    spies.and.mockClear();
    spies.desc.mockClear();
  });

  describe('listByUser', () => {
    it('scopes the WHERE clause to userId', async () => {
      const { repo, chain } = buildRepo([
        {
          id: rowId,
          userId,
          productName: 'X',
          productId: null,
          barcode: null,
          expiresAt: null,
          markedConsumedAt: null,
          notes: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      await repo.listByUser(userId, { limit: 5 });

      const { eq, desc } = getDrizzleSpies();
      expect(eq).toHaveBeenCalledWith(savedProducts.userId, userId);
      expect(desc).toHaveBeenCalledWith(savedProducts.createdAt);
      expect(desc).toHaveBeenCalledWith(savedProducts.id);
      // limit clamped: requested 5 → repo asks for limit + 1 = 6.
      expect(chain.limit).toHaveBeenCalledWith(6);
    });

    it('clamps an oversize limit to 50 and applies cursor when valid', async () => {
      const { repo, chain } = buildRepo([]);

      await repo.listByUser(userId, { cursor: 'VALID_CURSOR', limit: 999 });

      const { eq } = getDrizzleSpies();
      expect(eq).toHaveBeenCalledWith(savedProducts.userId, userId);
      // 999 → clamped to 50, repo fetches limit + 1 = 51.
      expect(chain.limit).toHaveBeenCalledWith(51);
    });

    it('uses default limit (20) when none is provided', async () => {
      const { repo, chain } = buildRepo([]);

      await repo.listByUser(userId, {});

      expect(chain.limit).toHaveBeenCalledWith(21);
    });

    it('returns nextCursor when the page is full and rows remain', async () => {
      const limit = 2;
      const rows = [
        {
          id: rowId,
          userId,
          productName: 'X',
          productId: null,
          barcode: null,
          expiresAt: null,
          markedConsumedAt: null,
          notes: null,
          createdAt: new Date('2026-01-02T00:00:00Z'),
          updatedAt: new Date('2026-01-02T00:00:00Z'),
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          userId,
          productName: 'Y',
          productId: null,
          barcode: null,
          expiresAt: null,
          markedConsumedAt: null,
          notes: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          // Sentinel row signalling "more results exist".
          id: '44444444-4444-4444-8444-444444444444',
          userId,
          productName: 'Z',
          productId: null,
          barcode: null,
          expiresAt: null,
          markedConsumedAt: null,
          notes: null,
          createdAt: new Date('2025-12-31T00:00:00Z'),
          updatedAt: new Date('2025-12-31T00:00:00Z'),
        },
      ];
      const { repo } = buildRepo(rows);

      const page = await repo.listByUser(userId, { limit });

      expect(page.items).toHaveLength(limit);
      expect(page.nextCursor).toBe('ENCODED_CURSOR');
    });

    it('returns nextCursor=null when the result fits in one page', async () => {
      const { repo } = buildRepo([
        {
          id: rowId,
          userId,
          productName: 'X',
          productId: null,
          barcode: null,
          expiresAt: null,
          markedConsumedAt: null,
          notes: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const page = await repo.listByUser(userId, { limit: 5 });

      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeNull();
    });
  });

  describe('findByIdForUser', () => {
    it('scopes the lookup to (id, userId)', async () => {
      const { repo } = buildRepo([{ id: rowId, userId }]);

      await repo.findByIdForUser(rowId, userId);

      const { eq } = getDrizzleSpies();
      expect(eq).toHaveBeenCalledWith(savedProducts.id, rowId);
      expect(eq).toHaveBeenCalledWith(savedProducts.userId, userId);
    });

    it('returns undefined when no row matches', async () => {
      const { repo } = buildRepo([]);

      await expect(repo.findByIdForUser(rowId, otherUserId)).resolves.toBeUndefined();
    });
  });

  describe('create', () => {
    it('inserts the supplied values and returns the new row', async () => {
      const inserted = {
        id: rowId,
        userId,
        productName: 'New',
        productId: null,
        barcode: null,
        expiresAt: null,
        markedConsumedAt: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const { repo, chain } = buildRepo([inserted]);

      const result = await repo.create({ userId, productName: 'New' });

      expect(chain.insert).toHaveBeenCalledWith(savedProducts);
      expect(chain.values).toHaveBeenCalledWith({ userId, productName: 'New' });
      expect(chain.returning).toHaveBeenCalled();
      expect(result).toEqual(inserted);
    });
  });

  describe('delete', () => {
    it('filters by both id and userId', async () => {
      const { repo, chain } = buildRepo([{ id: rowId }]);

      const removed = await repo.delete(rowId, userId);

      const { eq } = getDrizzleSpies();
      expect(chain.delete).toHaveBeenCalledWith(savedProducts);
      expect(eq).toHaveBeenCalledWith(savedProducts.id, rowId);
      expect(eq).toHaveBeenCalledWith(savedProducts.userId, userId);
      expect(removed).toBe(1);
    });

    it('returns 0 when no row was removed', async () => {
      const { repo } = buildRepo([]);

      const removed = await repo.delete(rowId, otherUserId);

      const { eq } = getDrizzleSpies();
      expect(eq).toHaveBeenCalledWith(savedProducts.userId, otherUserId);
      expect(removed).toBe(0);
    });
  });
});
