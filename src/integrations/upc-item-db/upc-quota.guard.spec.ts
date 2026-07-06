import { LoggerService } from '@/logging/logger.service';
import type { RedisQuotaPort } from '@/modules/rate-limiting/ports/redis-quota.port';

import { UPC_DAILY_CAP } from './upc.constants';
import { UpcQuotaGuard } from './upc-quota.guard';

/** Minimal in-memory fake — exercises the same INCR + EXPIRE contract as IoRedisQuotaAdapter. */
class FakeRedisQuotaPort implements RedisQuotaPort {
  private counters = new Map<string, number>();
  degraded = false;

  async incr(key: string): Promise<number> {
    if (this.degraded) return 0;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async expire(): Promise<void> {
    /* no-op for the fake */
  }

  async get(key: string): Promise<string | null> {
    const v = this.counters.get(key);
    return v === undefined ? null : String(v);
  }
}

describe('UpcQuotaGuard', () => {
  let redis: FakeRedisQuotaPort;
  let guard: UpcQuotaGuard;
  const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as LoggerService;

  beforeEach(() => {
    redis = new FakeRedisQuotaPort();
    guard = new UpcQuotaGuard(redis, logger);
  });

  it('allows calls while under the daily cap', async () => {
    const allowed = await guard.tryConsume();
    expect(allowed).toBe(true);
  });

  it('denies once the daily cap is exceeded', async () => {
    for (let i = 0; i < UPC_DAILY_CAP; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(await guard.tryConsume()).toBe(true);
    }
    const overCap = await guard.tryConsume();
    expect(overCap).toBe(false);
  });

  it('fails CLOSED (denies) when the Redis port is degraded — opposite of RateLimitService', async () => {
    redis.degraded = true;
    const allowed = await guard.tryConsume();
    expect(allowed).toBe(false);
  });

  it('fails CLOSED when the Redis port throws', async () => {
    jest.spyOn(redis, 'incr').mockRejectedValueOnce(new Error('connection reset'));
    const allowed = await guard.tryConsume();
    expect(allowed).toBe(false);
  });
});
