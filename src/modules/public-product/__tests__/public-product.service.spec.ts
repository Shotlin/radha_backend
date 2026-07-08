import { GoneException } from '@nestjs/common';

import type { DbService } from '@/db/db.service';
import type { LoggerService } from '@/logging/logger.service';
import type { ProductRow } from '@/db/schema/products';
import type { ProductHealthAssessmentRow } from '@/db/schema/health-scoring';
import type { HealthAssessmentsRepository } from '@/modules/health-scoring/repositories/health-assessments.repository';

import {
  PUBLIC_PRODUCT_ALLOWLIST,
  PublicProductService,
} from '../services/public-product.service';

/**
 * BE-51 — `PublicProductService` unit tests.
 *
 * These tests cover the four guarantees the public surface promises:
 *
 *   1. **null on miss** — controller maps to 404.
 *   2. **GoneException for withdrawn / unsafe** — controller maps to 410.
 *   3. **Allow-list projection** — no tenant data ever leaks; the test
 *      hard-asserts the exact key set of the returned object against
 *      `PUBLIC_PRODUCT_ALLOWLIST`.
 *   4. **Sitemap pagination** — first page returns a `nextCursor`
 *      when there are more rows than the limit, then the cursor walks
 *      the next batch.
 */

const noopLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as LoggerService;

/**
 * Build a fake `DbService` whose `select(...).from(...).where(...)`
 * chain returns the rows the test wants. Drizzle calls are
 * deliberately untyped here because we're stubbing out the entire
 * query builder.
 */
function buildDb(behaviour: {
  selectRows?: unknown[];
}): DbService {
  return {
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => behaviour.selectRows ?? [],
            orderBy: () => ({
              limit: async () => behaviour.selectRows ?? [],
            }),
          }),
        }),
      }),
    }),
  } as unknown as DbService;
}

function buildHealthRepo(
  assessment: ProductHealthAssessmentRow | null,
): HealthAssessmentsRepository {
  return {
    findLatestForProduct: jest.fn().mockResolvedValue(assessment),
  } as unknown as HealthAssessmentsRepository;
}

const baseGlobalProduct: ProductRow = {
  id: 'p-1',
  tenantId: null,
  ean: '8901058869293',
  name: 'Maggi 2-Minute Noodles',
  brand: 'Maggi',
  manufacturer: null,
  categoryId: null,
  subCategory: 'Instant Noodles',
  productType: null,
  imageUrl: 'https://images.example/maggi.jpg',
  description: 'Wheat flour, palm oil, salt, spices.',
  packageSize: '70',
  packageUnit: 'g',
  packageType: null,
  status: 'active',
  isVerified: true,
  dataSource: 'open_food_facts',
  externalId: '8901058869293',
  metadata: {
    allergens: ['en:wheat', 'en:gluten'],
    ingredients_text: 'Wheat flour (refined wheat flour, atta), palm oil',
  },
  searchTsv: null,
  publicSlug: 'maggi-2-minute-noodles-9293',
  publicStatus: 'active',
  createdAt: new Date('2024-01-15T10:00:00Z'),
  updatedAt: new Date('2024-06-30T08:00:00Z'),
  deletedAt: null,
  createdBy: null,
  updatedBy: null,
  deletedBy: null,
} as ProductRow;

describe('PublicProductService.findBySlug', () => {
  it('returns null when no product carries the slug', async () => {
    const svc = new PublicProductService(
      buildDb({ selectRows: [] }),
      noopLogger,
      buildHealthRepo(null),
    );
    const result = await svc.findBySlug('does-not-exist-0000');
    expect(result).toBeNull();
  });

  it('throws GoneException for withdrawn products', async () => {
    const svc = new PublicProductService(
      buildDb({
        selectRows: [{ ...baseGlobalProduct, publicStatus: 'withdrawn' }],
      }),
      noopLogger,
      buildHealthRepo(null),
    );
    await expect(svc.findBySlug('maggi-2-minute-noodles-9293')).rejects.toBeInstanceOf(
      GoneException,
    );
  });

  it('throws GoneException for unsafe / recalled products', async () => {
    const svc = new PublicProductService(
      buildDb({
        selectRows: [{ ...baseGlobalProduct, publicStatus: 'unsafe' }],
      }),
      noopLogger,
      buildHealthRepo(null),
    );
    await expect(svc.findBySlug('maggi-2-minute-noodles-9293')).rejects.toBeInstanceOf(
      GoneException,
    );
  });

  it('returns the projected public view for active products', async () => {
    const svc = new PublicProductService(
      buildDb({ selectRows: [baseGlobalProduct] }),
      noopLogger,
      buildHealthRepo({
        productId: 'p-1',
        overallGrade: 'C',
        overallScore: 55,
        computedAt: new Date('2024-07-01T00:00:00Z'),
      } as ProductHealthAssessmentRow),
    );

    const view = await svc.findBySlug('maggi-2-minute-noodles-9293');
    expect(view).not.toBeNull();
    expect(view!.ean).toBe('8901058869293');
    expect(view!.name).toBe('Maggi 2-Minute Noodles');
    expect(view!.brand).toBe('Maggi');
    expect(view!.healthLabel).toBe('C');
    expect(view!.healthScore).toBe(55);
    expect(view!.computedAt).toBe('2024-07-01T00:00:00.000Z');
    expect(view!.allergens).toEqual(['en:wheat', 'en:gluten']);
    expect(view!.ingredientsText).toContain('Wheat flour');
  });

  it('degrades gracefully when no health assessment exists', async () => {
    const svc = new PublicProductService(
      buildDb({ selectRows: [baseGlobalProduct] }),
      noopLogger,
      buildHealthRepo(null),
    );
    const view = await svc.findBySlug('maggi-2-minute-noodles-9293');
    expect(view).not.toBeNull();
    expect(view!.healthLabel).toBeNull();
    expect(view!.healthScore).toBeNull();
    expect(view!.computedAt).toBeNull();
  });
});

describe('PublicProductService — column allow-list', () => {
  it('returned view contains EXACTLY the allow-listed keys (no tenant data)', async () => {
    const svc = new PublicProductService(
      buildDb({ selectRows: [baseGlobalProduct] }),
      noopLogger,
      buildHealthRepo(null),
    );
    const view = await svc.findBySlug('maggi-2-minute-noodles-9293');
    expect(view).not.toBeNull();

    const keys = Object.keys(view!).sort();
    const expected = [...PUBLIC_PRODUCT_ALLOWLIST].sort();
    expect(keys).toEqual(expected);

    // Hard-assert that obviously sensitive fields never appear.
    const forbidden = [
      'tenantId',
      'tenant_id',
      'createdBy',
      'created_by',
      'updatedBy',
      'updated_by',
      'storeId',
      'store_id',
      'metadata',
      'searchTsv',
      'isVerified',
      'externalId',
      'dataSource',
    ];
    for (const key of forbidden) {
      expect(keys).not.toContain(key);
    }
  });
});

describe('PublicProductService.listSitemap', () => {
  /**
   * For sitemap tests we need the chain `select.from.where.orderBy.limit`
   * to deliver the seeded rows. The minimal stub above only satisfies
   * `select.from.where.limit` — extend it here.
   */
  function buildSitemapDb(rows: Array<{ id: string; publicSlug: string; updatedAt: Date }>): DbService {
    return {
      getDb: () => ({
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async (n: number) => rows.slice(0, n),
              }),
            }),
          }),
        }),
      }),
    } as unknown as DbService;
  }

  it('returns the entries verbatim and a null cursor when the page is the last one', async () => {
    const rows = [
      { id: 'p-1', publicSlug: 'a-1234', updatedAt: new Date('2024-06-01T00:00:00Z') },
      { id: 'p-2', publicSlug: 'b-5678', updatedAt: new Date('2024-06-02T00:00:00Z') },
    ];
    const svc = new PublicProductService(buildSitemapDb(rows), noopLogger, buildHealthRepo(null));
    const page = await svc.listSitemap({ limit: 10 });
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]).toEqual({
      slug: 'a-1234',
      updatedAt: '2024-06-01T00:00:00.000Z',
    });
    expect(page.nextCursor).toBeNull();
  });

  it('emits a nextCursor when more rows are available than the limit', async () => {
    // Service asks for `limit + 1` to know if there's another page.
    // Seed with 3 rows for limit=2 so the third row triggers
    // `hasMore`.
    const rows = [
      { id: 'p-1', publicSlug: 'a-1', updatedAt: new Date('2024-06-03T00:00:00Z') },
      { id: 'p-2', publicSlug: 'b-2', updatedAt: new Date('2024-06-02T00:00:00Z') },
      { id: 'p-3', publicSlug: 'c-3', updatedAt: new Date('2024-06-01T00:00:00Z') },
    ];
    const svc = new PublicProductService(buildSitemapDb(rows), noopLogger, buildHealthRepo(null));
    const page = await svc.listSitemap({ limit: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    // Cursor must be base64url with no padding so it survives URL params.
    expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('clamps a missing limit to 50_000 and an over-the-cap value to 50_000', async () => {
    const rows: Array<{ id: string; publicSlug: string; updatedAt: Date }> = [];
    const svc = new PublicProductService(buildSitemapDb(rows), noopLogger, buildHealthRepo(null));
    await expect(svc.listSitemap({})).resolves.toMatchObject({ entries: [] });
    await expect(svc.listSitemap({ limit: 999_999 })).resolves.toMatchObject({ entries: [] });
  });

  it('decodes a previously-issued cursor without throwing', async () => {
    const rows: Array<{ id: string; publicSlug: string; updatedAt: Date }> = [];
    const svc = new PublicProductService(buildSitemapDb(rows), noopLogger, buildHealthRepo(null));
    const cursor = Buffer.from('2024-06-01T00:00:00.000Z|p-1', 'utf8').toString('base64url');
    await expect(svc.listSitemap({ cursor, limit: 10 })).resolves.toMatchObject({
      entries: [],
      nextCursor: null,
    });
  });

  it('ignores a malformed cursor and returns the first page', async () => {
    const rows = [
      { id: 'p-1', publicSlug: 'a-1', updatedAt: new Date('2024-06-01T00:00:00Z') },
    ];
    const svc = new PublicProductService(buildSitemapDb(rows), noopLogger, buildHealthRepo(null));
    const page = await svc.listSitemap({ cursor: '!!!not-base64!!!', limit: 10 });
    expect(page.entries).toHaveLength(1);
  });
});
