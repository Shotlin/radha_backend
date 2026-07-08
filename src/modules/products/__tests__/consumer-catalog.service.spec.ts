import type { CatalogBrowsePage, CatalogCategory } from '../dto/consumer-catalog.dto';
import { ConsumerCatalogRepository } from '../repositories/consumer-catalog.repository';
import { ConsumerCatalogService } from '../services/consumer-catalog.service';

const buildRepoMock = (
  overrides: Partial<jest.Mocked<ConsumerCatalogRepository>> = {},
): ConsumerCatalogRepository =>
  ({
    listCategories: jest.fn().mockResolvedValue([]),
    browse: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    ...overrides,
  }) as unknown as ConsumerCatalogRepository;

describe('ConsumerCatalogService', () => {
  describe('listCategories', () => {
    it('passes through the repository categories', async () => {
      const categories: CatalogCategory[] = [
        { id: 'c-1', name: 'Biscuits', slug: 'biscuits', sortOrder: 0 },
        { id: 'c-2', name: 'Cold Drinks', slug: 'cold-drinks', sortOrder: 1 },
      ];
      const repo = buildRepoMock({
        listCategories: jest.fn().mockResolvedValue(categories),
      } as unknown as Partial<jest.Mocked<ConsumerCatalogRepository>>);
      const svc = new ConsumerCatalogService(repo);

      await expect(svc.listCategories()).resolves.toBe(categories);
      expect(repo.listCategories).toHaveBeenCalledTimes(1);
    });
  });

  describe('browse', () => {
    it('forwards the query to the repository and returns its page', async () => {
      const page: CatalogBrowsePage = {
        items: [
          {
            id: 'p-1',
            ean: '8901234567890',
            name: 'Oats Cookies',
            brand: 'Acme',
            imageUrl: null,
            category: 'Biscuits',
            healthScore: 72,
            healthGrade: 'B',
            healthStatus: 'green',
          },
        ],
        nextCursor: 'eyJzY29yZSI6NzIsImlkIjoicC0xIn0',
      };
      const browse = jest.fn().mockResolvedValue(page);
      const repo = buildRepoMock({
        browse,
      } as unknown as Partial<jest.Mocked<ConsumerCatalogRepository>>);
      const svc = new ConsumerCatalogService(repo);

      const query = { sort: 'health' as const, limit: 20 };
      await expect(svc.browse(query)).resolves.toBe(page);
      expect(browse).toHaveBeenCalledWith(query);
    });

    it('returns an empty page (no fabricated rows) when the catalog is empty', async () => {
      const repo = buildRepoMock();
      const svc = new ConsumerCatalogService(repo);

      const result = await svc.browse({ sort: 'health', limit: 20 });
      expect(result.items).toEqual([]);
      expect(result.nextCursor).toBeNull();
    });
  });
});
