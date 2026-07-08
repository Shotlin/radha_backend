import type { ExecutionContext } from '@nestjs/common';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';

import { PublicRateLimitGuard } from '../guards/public-rate-limit.guard';

const buildCtx = (ip: string): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ ip, headers: {} }),
    }),
  }) as unknown as ExecutionContext;

const buildConfig = (max: number, windowMs = 60_000) =>
  ({
    rateLimit: { windowMs, max },
  }) as never;

describe('PublicRateLimitGuard', () => {
  const ORIGINAL_SALT = process.env.ANALYTICS_HASH_SALT;
  beforeAll(() => {
    process.env.ANALYTICS_HASH_SALT = 'a'.repeat(64);
  });
  afterAll(() => {
    process.env.ANALYTICS_HASH_SALT = ORIGINAL_SALT;
  });

  it('allows traffic up to the configured limit', () => {
    const g = new PublicRateLimitGuard(buildConfig(3));
    const ctx = buildCtx('1.2.3.4');
    expect(g.canActivate(ctx)).toBe(true);
    expect(g.canActivate(ctx)).toBe(true);
    expect(g.canActivate(ctx)).toBe(true);
  });

  it('returns 429 once limit is exceeded', () => {
    const g = new PublicRateLimitGuard(buildConfig(2));
    const ctx = buildCtx('1.2.3.4');
    g.canActivate(ctx);
    g.canActivate(ctx);
    expect(() => g.canActivate(ctx)).toThrow(BusinessException);
    try {
      g.canActivate(ctx);
    } catch (err) {
      expect((err as BusinessException).code).toBe(ErrorCode.RATE_LIMIT_EXCEEDED);
    }
  });

  it('100 req/min limit returns 429 on the 101st request', () => {
    const g = new PublicRateLimitGuard(buildConfig(100));
    const ctx = buildCtx('1.2.3.5');
    for (let i = 0; i < 100; i += 1) {
      expect(g.canActivate(ctx)).toBe(true);
    }
    expect(() => g.canActivate(ctx)).toThrow(/Too many requests/);
  });

  it('different IPs hash to different buckets', () => {
    const g = new PublicRateLimitGuard(buildConfig(1));
    expect(g.canActivate(buildCtx('1.1.1.1'))).toBe(true);
    expect(g.canActivate(buildCtx('2.2.2.2'))).toBe(true);
    expect(() => g.canActivate(buildCtx('1.1.1.1'))).toThrow(BusinessException);
  });

  it('reset clears in-memory state for tests', () => {
    const g = new PublicRateLimitGuard(buildConfig(1));
    g.canActivate(buildCtx('5.5.5.5'));
    expect(() => g.canActivate(buildCtx('5.5.5.5'))).toThrow(BusinessException);
    g.reset();
    expect(g.canActivate(buildCtx('5.5.5.5'))).toBe(true);
  });
});
