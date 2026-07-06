import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';

/**
 * BE-29 — Public-endpoint rate limit guard.
 *
 * Lightweight token-bucket-by-key in-memory limiter used by the
 * public analytics + lead capture endpoints. Production deployments
 * with multiple API instances should replace this with a Redis
 * implementation (BE-46) — this implementation matches the rate-limit
 * profile from `ConfigService.rateLimit` and is safe enough for the
 * single-instance dev/staging path.
 *
 * The IP address is never stored. We hash it with a daily-rotating
 * salt (`ANALYTICS_HASH_SALT` + UTC date) so the limiter cache key
 * is anonymized per the BE-29 privacy requirement.
 */
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly config: ConfigService) {
    this.windowMs = this.config.rateLimit.windowMs;
    this.max = this.config.rateLimit.max;
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      ip?: string;
      ips?: string[];
      headers?: Record<string, string | string[] | undefined>;
      socket?: { remoteAddress?: string };
    }>();

    const key = this.identityKey(req);
    const now = Date.now();
    this.evictExpired(now);

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    bucket.count += 1;
    if (bucket.count > this.max) {
      throw new BusinessException(
        ErrorCode.RATE_LIMIT_EXCEEDED,
        `Too many requests. Limit: ${this.max} per ${Math.round(this.windowMs / 1000)}s`,
      );
    }
    return true;
  }

  private identityKey(req: {
    ip?: string;
    ips?: string[];
    headers?: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string };
  }): string {
    const candidate =
      req.ips?.[0] ??
      req.ip ??
      (typeof req.headers?.['x-forwarded-for'] === 'string'
        ? req.headers['x-forwarded-for'].split(',')[0].trim()
        : undefined) ??
      req.socket?.remoteAddress ??
      'unknown';

    // Daily-rotating salt: rate limiter never sees raw IPs and the
    // hash space changes every day so long-term tracking is impossible.
    const dayBucket = new Date().toISOString().slice(0, 10);
    const salt = process.env.ANALYTICS_HASH_SALT ?? 'rate-limit-fallback-salt';
    return crypto
      .createHash('sha256')
      .update(`${candidate}:${dayBucket}:${salt}`)
      .digest('hex')
      .slice(0, 32);
  }

  private evictExpired(now: number): void {
    if (this.buckets.size < 10_000) return;
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= now) this.buckets.delete(k);
    }
  }

  /** Test hook — clears in-memory state between specs. */
  reset(): void {
    this.buckets.clear();
  }
}
