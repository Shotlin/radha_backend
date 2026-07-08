import { LoggerService } from '@/logging/logger.service';
import type { RedisQuotaPort } from '@/modules/rate-limiting/ports/redis-quota.port';

import { UpcMapperService } from './upc-mapper.service';
import { UpcQuotaGuard } from './upc-quota.guard';
import { UpcItemDbService } from './upc.service';

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

describe('UpcItemDbService', () => {
  let service: UpcItemDbService;
  let quota: jest.Mocked<UpcQuotaGuard>;
  let redis: jest.Mocked<RedisQuotaPort>;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as LoggerService;

  beforeEach(() => {
    quota = { tryConsume: jest.fn().mockResolvedValue(true) } as unknown as jest.Mocked<UpcQuotaGuard>;
    redis = {
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<RedisQuotaPort>;
    service = new UpcItemDbService(quota, new UpcMapperService(), logger, redis);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns a mapped hit with dataSource upc_item_db on a successful lookup', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        code: 'OK',
        total: 1,
        offset: 0,
        items: [
          {
            ean: '0049000028911',
            upc: '049000028911',
            title: 'Diet Coke Soda Soft Drink, 12 fl oz, 12 Pack',
            brand: 'Diet Coke',
            category: 'Food, Beverages & Tobacco > Beverages > Soda',
            images: ['https://example.com/coke.jpg'],
          },
        ],
      }),
    );

    const hit = await service.lookupByEan('049000028911');

    expect(hit?.mapped.dataSource).toBe('upc_item_db');
    expect(hit?.mapped.name).toContain('Diet Coke');
    expect(hit?.mapped.category).toBe('Food, Beverages & Tobacco');
    expect(hit?.mapped.subCategory).toBe('Beverages');
    expect(hit?.nutrition).toBeNull();
  });

  it('checks the quota guard BEFORE making a network call', async () => {
    quota.tryConsume.mockResolvedValueOnce(false);

    const hit = await service.lookupByEan('049000028911');

    expect(hit).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips the network call entirely when the EAN is already negative-cached', async () => {
    redis.get.mockResolvedValueOnce('1');

    const hit = await service.lookupByEan('0000000000000');

    expect(hit).toBeNull();
    expect(quota.tryConsume).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records a negative-cache entry on a genuine miss so repeat scans skip the network', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'OK', total: 0, offset: 0, items: [] }));

    const hit = await service.lookupByEan('0000000000000');

    expect(hit).toBeNull();
    expect(redis.incr).toHaveBeenCalledWith('upc_miss:0000000000000');
    expect(redis.expire).toHaveBeenCalledWith('upc_miss:0000000000000', expect.any(Number));
  });
});
