import { LoggerService } from '@/logging/logger.service';

import { OffCacheService } from '../off-cache.service';
import { OffCircuitBreakerService } from '../off-circuit-breaker.service';
import { OpenFoodFactsService } from '../off.service';
import type { OffProduct } from '../off.types';

class TestOffService extends OpenFoodFactsService {
  public nextResponse: { ok: boolean; status: number; body: unknown } = {
    ok: true,
    status: 200,
    body: { status: 1, product: { code: '3017620422003', product_name: 'Nutella' } },
  };

  protected async request(_url: string): Promise<Response> {
    return new Response(JSON.stringify(this.nextResponse.body), {
      status: this.nextResponse.status,
    });
  }
}

const buildSvc = (cache: Partial<OffCacheService> = {}): TestOffService => {
  const fullCache = {
    get: jest.fn().mockResolvedValue(null),
    setHit: jest.fn().mockResolvedValue(undefined),
    setMiss: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn(),
    ...cache,
  } as unknown as OffCacheService;
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as LoggerService;
  const breaker = new OffCircuitBreakerService(logger);
  return new TestOffService(fullCache, breaker, logger);
};

describe('OpenFoodFactsService', () => {
  it('returns the cached product on cache hit without firing the network', async () => {
    const cached = {
      ean: '3017620422003',
      product: { code: '3017620422003', product_name: 'Cached Nutella' } as OffProduct,
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      hitCount: 1,
      fetchSuccess: true,
    };
    const svc = buildSvc({ get: jest.fn().mockResolvedValue(cached) });
    const requestSpy = jest.spyOn(
      svc as unknown as { request: () => Promise<Response> },
      'request',
    );
    const result = await svc.lookupByEan('3017620422003');
    expect(result?.product_name).toBe('Cached Nutella');
    expect(requestSpy).not.toHaveBeenCalled();
    const stats = svc.getStats();
    expect(stats.cacheHits).toBe(1);
  });

  it('returns null when OFF reports product not found and writes a miss to cache', async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      setHit: jest.fn(),
      setMiss: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn(),
    };
    const svc = buildSvc(cache);
    svc.nextResponse = { ok: true, status: 200, body: { status: 0, status_verbose: 'no match' } };
    const result = await svc.lookupByEan('9999999999999');
    expect(result).toBeNull();
    expect(cache.setMiss).toHaveBeenCalledWith('9999999999999');
    expect(cache.setHit).not.toHaveBeenCalled();
  });

  it('returns the parsed product on a successful fetch and writes the cache', async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      setHit: jest.fn().mockResolvedValue(undefined),
      setMiss: jest.fn(),
      invalidate: jest.fn(),
    };
    const svc = buildSvc(cache);
    svc.nextResponse = {
      ok: true,
      status: 200,
      body: { status: 1, product: { code: '3017620422003', product_name: 'Nutella' } },
    };
    const result = await svc.lookupByEan('3017620422003');
    expect(result?.product_name).toBe('Nutella');
    expect(cache.setHit).toHaveBeenCalled();
    const stats = svc.getStats();
    expect(stats.apiSuccess).toBe(1);
  });

  it('returns null and records a failure when OFF returns 5xx', async () => {
    const svc = buildSvc();
    svc.nextResponse = { ok: false, status: 502, body: 'bad gateway' };
    const result = await svc.lookupByEan('3017620422003');
    expect(result).toBeNull();
    const stats = svc.getStats();
    expect(stats.apiFailures).toBe(1);
  });
});
