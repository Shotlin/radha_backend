import { LoggerService } from '@/logging/logger.service';

import type { ProductRow } from '@/db/schema/products';

import { SearchRepository } from '../repositories/search.repository';
import { ProductSearchService } from '../services/product-search.service';
import { SearchAnalyticsService } from '../services/search-analytics.service';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const buildRepoMock = (overrides: Partial<jest.Mocked<SearchRepository>> = {}) => {
  const repo = {
    fullTextSearch: jest.fn().mockResolvedValue({ data: [], total: 0, nextCursor: null }),
    autocomplete: jest.fn().mockResolvedValue([]),
    getFacets: jest.fn().mockResolvedValue({
      categories: [],
      brands: [],
      healthGrades: [],
      processingLevels: [],
    }),
    getPopular: jest.fn().mockResolvedValue([]),
    findSimilar: jest.fn().mockResolvedValue([]),
    incrementPopularity: jest.fn().mockResolvedValue(undefined),
    logSearch: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SearchRepository;
  return repo;
};

const buildService = (
  repoOverrides: Partial<jest.Mocked<SearchRepository>> = {},
): { svc: ProductSearchService; repo: SearchRepository; analytics: SearchAnalyticsService } => {
  const repo = buildRepoMock(repoOverrides);
  const analytics = new SearchAnalyticsService(repo, buildLogger());
  const svc = new ProductSearchService(repo, analytics);
  return { svc, repo, analytics };
};

describe('ProductSearchService.search', () => {
  it('returns the repo result with sanitised query and timing', async () => {
    const product = { id: 'p-1', name: 'Chocolate Bar', tenantId: 't-1' } as unknown as ProductRow;
    const { svc, repo } = buildService({
      fullTextSearch: jest.fn().mockResolvedValue({
        data: [product],
        total: 1,
        nextCursor: null,
      }),
    } as unknown as Partial<jest.Mocked<SearchRepository>>);

    const result = await svc.search(
      {
        q: '  chocolate  ',
        limit: 20,
        orderBy: 'relevance',
        orderDirection: 'desc',
        includeFacets: false,
      },
      't-1',
      'u-1',
    );
    expect(result.query).toBe('chocolate');
    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect((repo.fullTextSearch as jest.Mock).mock.calls[0][0].rawQuery).toBe('chocolate');
  });

  it('does not log analytics for empty queries', async () => {
    const { svc, repo } = buildService();
    await svc.search(
      { limit: 20, orderBy: 'relevance', orderDirection: 'desc', includeFacets: false },
      't-1',
      'u-1',
    );
    // Allow any deferred fire-and-forget to settle
    await Promise.resolve();
    expect(repo.logSearch as jest.Mock).not.toHaveBeenCalled();
  });

  it('logs analytics for non-empty queries (fire-and-forget)', async () => {
    const { svc, repo } = buildService({
      fullTextSearch: jest.fn().mockResolvedValue({ data: [], total: 0, nextCursor: null }),
    } as unknown as Partial<jest.Mocked<SearchRepository>>);
    await svc.search(
      {
        q: 'chocolate',
        limit: 20,
        orderBy: 'relevance',
        orderDirection: 'desc',
        includeFacets: false,
      },
      't-1',
      'u-1',
    );
    // Drain the microtask queue so the fire-and-forget persist runs
    await new Promise((r) => setImmediate(r));
    expect(repo.logSearch as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({ queryText: 'chocolate', tenantId: 't-1', userId: 'u-1' }),
    );
  });

  it('includes facets when includeFacets=true', async () => {
    const { svc, repo } = buildService({
      getFacets: jest.fn().mockResolvedValue({
        categories: [{ value: 'c-1', label: 'c-1', count: 5 }],
        brands: [],
        healthGrades: [],
        processingLevels: [],
      }),
    } as unknown as Partial<jest.Mocked<SearchRepository>>);

    const result = await svc.search(
      {
        q: 'snack',
        limit: 20,
        orderBy: 'relevance',
        orderDirection: 'desc',
        includeFacets: true,
      },
      't-1',
      'u-1',
    );
    expect(result.facets?.categories).toHaveLength(1);
    expect(repo.getFacets as jest.Mock).toHaveBeenCalledWith('t-1');
  });

  it('forwards filters to the repository', async () => {
    const { svc, repo } = buildService();
    await svc.search(
      {
        q: 'chocolate',
        category: '11111111-1111-1111-1111-111111111111',
        brand: 'Cadbury',
        healthGrade: ['A', 'B'],
        childSafe: true,
        excludeProcessed: true,
        status: 'active',
        limit: 20,
        orderBy: 'relevance',
        orderDirection: 'desc',
        includeFacets: false,
      },
      't-1',
      'u-1',
    );
    const filters = (repo.fullTextSearch as jest.Mock).mock.calls[0][0].filters;
    expect(filters).toMatchObject({
      brand: 'Cadbury',
      category: '11111111-1111-1111-1111-111111111111',
      healthGrades: ['A', 'B'],
      childSafe: true,
      excludeProcessed: true,
      status: 'active',
    });
  });
});

describe('ProductSearchService.autocomplete', () => {
  it('maps repo seeds into AutocompleteSuggestion shape', async () => {
    const { svc } = buildService({
      autocomplete: jest.fn().mockResolvedValue([
        { id: 'p-1', name: 'Chocolate Bar', brand: 'Cadbury', matchedField: 'name' },
        { id: 'p-2', name: 'Mango Cookies', brand: 'Cadbury', matchedField: 'brand' },
      ]),
    } as unknown as Partial<jest.Mocked<SearchRepository>>);

    const result = await svc.autocomplete({ q: 'cho', limit: 10, type: 'all' }, 't-1', 'u-1');
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions[0]).toMatchObject({
      text: 'Chocolate Bar',
      productId: 'p-1',
      type: 'product',
      matchedField: 'name',
    });
    // For brand-matched seed, the text is the brand
    expect(result.suggestions[1].text).toBe('Cadbury');
  });
});

describe('ProductSearchService.recordScan', () => {
  it('bumps popularity by one scan', async () => {
    const { svc, repo } = buildService();
    await svc.recordScan('p-1', 't-1');
    expect(repo.incrementPopularity as jest.Mock).toHaveBeenCalledWith('p-1', 't-1', { scans: 1 });
  });
});
