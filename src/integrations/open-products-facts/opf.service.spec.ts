import { LoggerService } from '@/logging/logger.service';

import { OpfCacheService } from './opf-cache.service';
import { OpfMapperService } from './opf-mapper.service';
import { OpenProductsFactsService } from './opf.service';
import type { OpfProduct } from './opf.types';

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

describe('OpenProductsFactsService', () => {
  let service: OpenProductsFactsService;
  let cache: jest.Mocked<OpfCacheService>;
  let mapper: OpfMapperService;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as LoggerService;

  beforeEach(() => {
    cache = {
      get: jest.fn().mockResolvedValue(null),
      setHit: jest.fn().mockResolvedValue(undefined),
      setMiss: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<OpfCacheService>;
    mapper = new OpfMapperService();
    service = new OpenProductsFactsService(cache, mapper, logger);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const battery: OpfProduct = {
    code: '4068706178948',
    product_name: 'AA Battery 4-pack',
    brands: 'Varta',
    categories_tags: ['en:battery'],
    image_front_url: 'https://images.openproductsfacts.org/front.jpg',
  };

  it('returns a mapped hit with dataSource open_products_facts on a successful lookup', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 1, product: battery }));

    const hit = await service.lookupByEan('4068706178948');

    expect(hit).not.toBeNull();
    expect(hit?.mapped.dataSource).toBe('open_products_facts');
    expect(hit?.mapped.name).toBe('AA Battery 4-pack');
    expect(hit?.nutrition).toBeNull(); // household goods have no nutrition concept
    expect(cache.setHit).toHaveBeenCalledWith('4068706178948', battery);
  });

  it('returns null and negative-caches on a real "not found" response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 0, status_verbose: 'product not found' }));

    const hit = await service.lookupByEan('0000000000000');

    expect(hit).toBeNull();
    expect(cache.setMiss).toHaveBeenCalledWith('0000000000000');
  });

  it('does not call fetch when the cache already has a negative entry', async () => {
    cache.get.mockResolvedValueOnce({
      ean: '0000000000000',
      product: null,
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
      hitCount: 1,
      fetchSuccess: false,
    });

    const hit = await service.lookupByEan('0000000000000');

    expect(hit).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
