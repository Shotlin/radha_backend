import { Inject, Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import {
  REDIS_QUOTA_PORT,
  RedisQuotaPort,
} from '@/modules/rate-limiting/ports/redis-quota.port';
import { secondsUntilMidnightIST, todayIST } from '@/modules/rate-limiting/utils/ist-time.util';

import { UPC_DAILY_CAP } from './upc.constants';

/**
 * Global (not per-user) daily quota guard for UPCitemdb's free tier.
 *
 * Reuses the existing `RedisQuotaPort` from the rate-limiting module
 * (atomic INCR + EXPIRE) rather than standing up new infra — same
 * mechanism `RateLimitService` uses for per-user quotas.
 *
 * Deliberate deviation from `RateLimitService`'s documented policy:
 * that service FAILS OPEN when Redis is degraded (a per-user quota
 * miss is low-risk — worst case one user scans a bit more than their
 * tier allows). This guard FAILS CLOSED instead: UPCitemdb's quota is
 * a hard *global* 100/day ceiling shared by every RADHA user, and
 * silently exceeding it risks the key getting throttled or banned
 * with no way to detect it. Skipping the provider for a few minutes
 * during a Redis blip is the safe trade — the other three providers
 * (Open Food/Beauty/Products Facts) are unaffected either way.
 */
@Injectable()
export class UpcQuotaGuard {
  constructor(
    @Inject(REDIS_QUOTA_PORT) private readonly redis: RedisQuotaPort,
    private readonly logger: LoggerService,
  ) {}

  async tryConsume(now: Date = new Date()): Promise<boolean> {
    const key = `upc_item_db_quota:${todayIST(now)}`;

    let used: number;
    try {
      used = await this.redis.incr(key);
    } catch (err) {
      this.logger.warn('upc.quota.redis_error_fail_closed', {
        message: err instanceof Error ? err.message : 'unknown',
      });
      return false;
    }

    if (!Number.isFinite(used) || used <= 0) {
      // Degraded port (mirrors IoRedisQuotaAdapter returning 0 when
      // disconnected) — can't prove we're under quota, so don't risk it.
      this.logger.warn('upc.quota.degraded_fail_closed', { key });
      return false;
    }

    if (used > UPC_DAILY_CAP) {
      this.logger.warn('upc.quota.exceeded', { key, used, cap: UPC_DAILY_CAP });
      return false;
    }

    await this.redis.expire(key, secondsUntilMidnightIST(now));
    return true;
  }
}
