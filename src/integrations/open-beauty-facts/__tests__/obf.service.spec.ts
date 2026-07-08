import { LoggerService } from '@/logging/logger.service';

import { ObfCacheService } from './obf-cache.service';
import { ObfMapperService } from './obf-mapper.service';
import { OpenBeautyFactsService } from './obf.service';
import type { ObfProduct } from './obf.types';

/** Build a minimal fetch Response stand-in (mirrors gemini-llm.provider.spec.ts). */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

describe('OpenBeautyFactsService', () => {
  let service: OpenBeautyFactsService;
  let cache: jest.Mocked<ObfCacheService>;
  let mapper: ObfMapperService;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as LoggerService;

  beforeEach(() => {
    cache = {
      get: jest.fn().mockResolvedValue(null),
      setHit: jest.fn().mockResolvedValue(undefined),
      setMiss: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ObfCacheService>;
    mapper = new ObfMapperService();
    service = new OpenBeautyFactsService(cache, mapper, logger);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const soap: ObfProduct = {
    code: '8711600804357',
    product_name: 'Dove pampering',
    brands: 'Unilever',
    categories_tags: ['en:hygiene', 'en:soaps'],
    image_front_url: 'https://images.openbeautyfacts.org/front.jpg',
  };

  it('returns a mapped hit with dataSource open_beauty_facts on a successful lookup', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 1, product: soap }));

    const hit = await service.lookupByEan('8711600804357');

    expect(hit).not.toBeNull();
    expect(hit?.mapped.dataSource).toBe('open_beauty_facts');
    expect(hit?.mapped.name).toBe('Dove pampering');
    expect(hit?.mapped.brand).toBe('Unilever');
    expect(hit?.nutrition).toBeNull(); // cosmetics have no nutrition concept
    expect(cache.setHit).toHaveBeenCalledWith('8711600804357', soap);
  });

  it('hits the cache and never calls fetch when the cache has the product', async () => {
    cache.get.mockResolvedValueOnce({
      ean: '8711600804357',
      product: soap,
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
      hitCount: 1,
      fetchSuccess: true,
    });

    const hit = await service.lookupByEan('8711600804357');

    expect(hit?.mapped.name).toBe('Dove pampering');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null and negative-caches on a real "not found" response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 0, status_verbose: 'product not found' }));

    const hit = await service.lookupByEan('0000000000000');

    expect(hit).toBeNull();
    expect(cache.setMiss).toHaveBeenCalledWith('0000000000000');
  });

  it('trips the circuit breaker after repeated failures and short-circuits further calls', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    for (let i = 0; i < 5; i += 1) {
      await service.lookupByEan(`failing-ean-${i}`);
    }
    expect(service.getStats().circuitState).toBe('open');

    fetchMock.mockClear();
    const hit = await service.lookupByEan('another-ean');
    expect(hit).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled(); // short-circuited, no network attempt
  });
});
