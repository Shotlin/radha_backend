import type { LoggerService } from '@/logging/logger.service';
import type { AuditLogService } from '@/observability/audit-log.service';

import type { QuotaKind } from '../dto/rate-limit-result.dto';
import type { RedisQuotaPort, UserTierPort } from '../ports/redis-quota.port';
import { QuotaConfigService } from '../services/quota-config.service';
import { RateLimitService } from '../services/rate-limit.service';

import type { SubscriptionTier } from '@radha/shared-types';

class FakeRedis implements RedisQuotaPort {
  store = new Map<string, number>();
  ttls = new Map<string, number>();
  failNextIncr = false;

  async incr(key: string): Promise<number> {
    if (this.failNextIncr) {
      this.failNextIncr = false;
      throw new Error('redis down');
    }
    const v = (this.store.get(key) ?? 0) + 1;
    this.store.set(key, v);
    return v;
  }

  async expire(key: string, seconds: number): Promise<void> {
    this.ttls.set(key, seconds);
  }

  async get(key: string): Promise<string | null> {
    const v = this.store.get(key);
    return v === undefined ? null : String(v);
  }
}

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  }) as unknown as LoggerService;

const buildAudit = (): AuditLogService =>
  ({ logAction: jest.fn(async () => undefined) }) as unknown as AuditLogService;

const buildTier = (tier: SubscriptionTier): UserTierPort => ({
  resolveTier: jest.fn(async () => ({ tier })),
});

const buildSvc = (tier: SubscriptionTier) => {
  const redis = new FakeRedis();
  const tierPort = buildTier(tier);
  const config = new QuotaConfigService();
  const logger = buildLogger();
  const audit = buildAudit();
  const svc = new RateLimitService(redis, tierPort, config, logger, audit);
  return { svc, redis, tierPort, logger, audit };
};

describe('RateLimitService.checkAndIncrement', () => {
  describe('free_consumer scan quota (50/day)', () => {
    it('allows the first 50 scans of the day', async () => {
      const { svc } = buildSvc('free_consumer');
      for (let i = 1; i <= 50; i++) {
        const r = await svc.checkAndIncrement('user-1', 'scan');
        expect(r.allowed).toBe(true);
        expect(r.used).toBe(i);
        expect(r.limit).toBe(50);
      }
    });

    it('rejects the 51st scan with structured 429 metadata', async () => {
      const { svc, audit } = buildSvc('free_consumer');
      for (let i = 0; i < 50; i++) await svc.checkAndIncrement('user-1', 'scan');

      const r = await svc.checkAndIncrement('user-1', 'scan');
      expect(r.allowed).toBe(false);
      expect(r.quota).toBe('scan');
      expect(r.limit).toBe(50);
      expect(r.used).toBe(51);
      expect(r.window).toBe('daily');
      expect(r.resetAt).toMatch(/T\d{2}:30:00\.000Z$/); // IST midnight = HH:30 UTC
      expect((audit.logAction as jest.Mock).mock.calls.length).toBe(1);
    });

    it('uses an EXPIRE TTL bounded by the IST midnight reset', async () => {
      const { svc, redis } = buildSvc('free_consumer');
      await svc.checkAndIncrement('user-1', 'scan');
      const ttls = Array.from(redis.ttls.values());
      expect(ttls.length).toBe(1);
      expect(ttls[0]).toBeGreaterThan(0);
      expect(ttls[0]).toBeLessThanOrEqual(24 * 3600);
    });

    it('uses a daily quota key', async () => {
      const { svc, redis } = buildSvc('free_consumer');
      await svc.checkAndIncrement('user-1', 'scan');
      const keys = Array.from(redis.store.keys());
      expect(keys.length).toBe(1);
      expect(keys[0]).toMatch(/^quota:user-1:scan:\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('free_consumer save quota (5)', () => {
    it('allows the first 5 saves and rejects the 6th', async () => {
      const { svc } = buildSvc('free_consumer');
      for (let i = 1; i <= 5; i++) {
        const r = await svc.checkAndIncrement('user-1', 'save');
        expect(r.allowed).toBe(true);
      }
      const r = await svc.checkAndIncrement('user-1', 'save');
      expect(r.allowed).toBe(false);
      expect(r.quota).toBe('save');
      expect(r.limit).toBe(5);
    });
  });

  describe('premium_consumer', () => {
    it('always allows scan and save without touching Redis', async () => {
      const { svc, redis } = buildSvc('premium_consumer');
      const r1 = await svc.checkAndIncrement('user-1', 'scan');
      const r2 = await svc.checkAndIncrement('user-1', 'save');
      expect(r1).toEqual({ allowed: true });
      expect(r2).toEqual({ allowed: true });
      expect(redis.store.size).toBe(0);
    });
  });

  describe('starter monthly scan quota (5,000/month)', () => {
    it('uses a monthly quota key and resets at month-end IST', async () => {
      const { svc, redis } = buildSvc('starter');
      const r = await svc.checkAndIncrement('user-7', 'scan');
      expect(r.allowed).toBe(true);
      expect(r.window).toBe('monthly');
      const keys = Array.from(redis.store.keys());
      expect(keys[0]).toMatch(/^quota_month:user-7:scan:\d{4}-\d{2}$/);
    });

    it('blocks the 5,001st scan in the month', async () => {
      const { svc, redis } = buildSvc('starter');
      // Pre-seed a counter representing 5,000 prior scans this month.
      const seedRes = await svc.checkAndIncrement('user-7', 'scan');
      const key = Array.from(redis.store.keys())[0];
      redis.store.set(key, 5000);
      void seedRes;

      const r = await svc.checkAndIncrement('user-7', 'scan');
      expect(r.allowed).toBe(false);
      expect(r.limit).toBe(5000);
      expect(r.used).toBe(5001);
      expect(r.window).toBe('monthly');
    });

    it('does not enforce save quota for starter (saved is unlimited)', async () => {
      const { svc } = buildSvc('starter');
      for (let i = 0; i < 100; i++) {
        const r = await svc.checkAndIncrement('user-7', 'save');
        expect(r.allowed).toBe(true);
      }
    });
  });

  describe('trial_pro', () => {
    it('shares the 5,000/month scan limit with starter', async () => {
      const { svc } = buildSvc('trial_pro');
      const r = await svc.checkAndIncrement('u', 'scan');
      expect(r.limit).toBe(5000);
      expect(r.window).toBe('monthly');
    });
  });

  describe('Redis degradation', () => {
    it('fails open when Redis throws', async () => {
      const { svc, redis, logger } = buildSvc('free_consumer');
      redis.failNextIncr = true;
      const r = await svc.checkAndIncrement('user-1', 'scan');
      expect(r.allowed).toBe(true);
      expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
        'rate_limit.redis_degraded',
        expect.objectContaining({ userId: 'user-1', kind: 'scan' as QuotaKind }),
      );
    });

    it('fails open when incr returns 0 (no-op port)', async () => {
      const noop: RedisQuotaPort = {
        incr: jest.fn(async () => 0),
        expire: jest.fn(async () => undefined),
        get: jest.fn(async () => null),
      };
      const svc = new RateLimitService(
        noop,
        buildTier('free_consumer'),
        new QuotaConfigService(),
        buildLogger(),
        buildAudit(),
      );
      const r = await svc.checkAndIncrement('u', 'scan');
      expect(r.allowed).toBe(true);
    });
  });

  describe('per-user isolation', () => {
    it('keeps separate counters per user', async () => {
      const { svc, redis } = buildSvc('free_consumer');
      await svc.checkAndIncrement('alice', 'scan');
      await svc.checkAndIncrement('bob', 'scan');
      expect(redis.store.size).toBe(2);
      expect([...redis.store.values()]).toEqual([1, 1]);
    });
  });

  describe('empty userId', () => {
    it('rejects an empty userId without resolving tier', async () => {
      const { svc, tierPort } = buildSvc('free_consumer');
      const r = await svc.checkAndIncrement('', 'scan');
      expect(r.allowed).toBe(false);
      expect((tierPort.resolveTier as jest.Mock)).not.toHaveBeenCalled();
    });
  });

  describe('analytics event', () => {
    it('emits feature_locked_seen on quota exceed', async () => {
      const { svc, logger } = buildSvc('free_consumer');
      for (let i = 0; i < 50; i++) await svc.checkAndIncrement('user-2', 'scan');
      await svc.checkAndIncrement('user-2', 'scan');
      const calls = (logger.info as jest.Mock).mock.calls;
      const matched = calls.find((c) => c[0] === 'analytics.feature_locked_seen');
      expect(matched).toBeDefined();
      expect(matched?.[1]).toMatchObject({
        analytics: true,
        event: 'feature_locked_seen',
        properties: expect.objectContaining({
          userId: 'user-2',
          quota: 'scan',
          limit: 50,
        }),
      });
    });
  });
});

describe('RateLimitService.getUsage', () => {
  it('returns counter without incrementing', async () => {
    const { svc, redis } = buildSvc('free_consumer');
    await svc.checkAndIncrement('user-1', 'scan');
    await svc.checkAndIncrement('user-1', 'scan');
    const before = Array.from(redis.store.values())[0];

    const usage = await svc.getUsage('user-1', 'scan');
    expect(usage.used).toBe(2);
    expect(usage.allowed).toBe(true);
    expect(usage.limit).toBe(50);
    const after = Array.from(redis.store.values())[0];
    expect(after).toBe(before); // not mutated
  });

  it('reports unlimited tiers as allowed without quota fields', async () => {
    const { svc } = buildSvc('premium_consumer');
    const usage = await svc.getUsage('user-1', 'scan');
    expect(usage).toEqual({ allowed: true });
  });
});

describe('QuotaConfigService', () => {
  const cfg = new QuotaConfigService();

  it('marks free_consumer scan as 50/daily', () => {
    expect(cfg.getLimit('free_consumer', 'scan')).toEqual({
      tier: 'free_consumer',
      kind: 'scan',
      limit: 50,
      window: 'daily',
    });
  });

  it('marks free_consumer save as 5/daily', () => {
    expect(cfg.getLimit('free_consumer', 'save')).toMatchObject({ limit: 5, window: 'daily' });
  });

  it('marks starter scan as 5000/monthly', () => {
    expect(cfg.getLimit('starter', 'scan')).toMatchObject({ limit: 5000, window: 'monthly' });
  });

  it('marks premium_consumer save as unlimited', () => {
    expect(cfg.isUnlimited('premium_consumer', 'save')).toBe(true);
    expect(cfg.getLimit('premium_consumer', 'save').limit).toBe(Number.POSITIVE_INFINITY);
  });

  it('marks growth/pro as unlimited for both kinds', () => {
    expect(cfg.isUnlimited('growth', 'scan')).toBe(true);
    expect(cfg.isUnlimited('pro', 'save')).toBe(true);
  });
});
