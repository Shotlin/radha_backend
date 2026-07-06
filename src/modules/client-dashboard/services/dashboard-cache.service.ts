import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';
import { LoggerService } from '@/logging/logger.service';

import type { IDashboardCacheInvalidator } from '../types/dashboard.types';

/**
 * BE-30 — Dashboard cache + invalidation.
 *
 * Wraps `ioredis` with the small surface the dashboard needs:
 * `get`, `set` (with TTL), and `invalidate` (KEYS + DEL). The
 * `IDashboardCacheInvalidator` interface is implemented so other
 * modules (scans, expiry, tasks) can call `invalidateStore(...)`
 * from their post-write hooks without depending on the dashboard
 * module.
 *
 * Resilience:
 *   - `ioredis` is lazy-loaded so unit tests and Redis-less dev
 *     environments still boot. When the import fails or the
 *     connection errors, every call becomes a no-op (logged once)
 *     and the dashboard service falls through to its uncached path.
 *   - `set`, `get`, `del`, `keys` all swallow errors. A cache
 *     outage must not break the API.
 *
 * Keying:
 *   - Per-user dashboard payload      → `dashboard:user:<userId>:<storeId>`
 *   - Per-store generic sections      → `dashboard:store:<storeId>:<section>`
 *   - Per-tenant multi-store summary  → `dashboard:tenant:<tenantId>:multi`
 *
 * `invalidateStore(storeId)` walks `dashboard:*` keys and deletes
 * any whose suffix references the store. KEYS is fine here: the
 * dashboard cache is small (one entry per active user + per store)
 * and invalidation runs at most a few times per second per store.
 */
type RedisLike = {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  quit(): Promise<unknown>;
  on(event: string, listener: (err: Error) => void): void;
};

@Injectable()
export class DashboardCacheService
  implements OnModuleInit, OnModuleDestroy, IDashboardCacheInvalidator
{
  private readonly logger = new Logger(DashboardCacheService.name);

  private static readonly KEY_PREFIX = 'dashboard:';
  /** Default TTL — 5 minutes per the BE-30 spec. */
  static readonly DEFAULT_TTL_SECONDS = 300;

  private redis: RedisLike | null = null;
  private degraded = false;

  constructor(
    private readonly config: ConfigService,
    private readonly appLogger: LoggerService,
  ) {}

  async onModuleInit(): Promise<void> {
    type IoRedisModule = typeof import('ioredis');
    const ioredis = (await import('ioredis').catch(() => null)) as IoRedisModule | null;
    if (!ioredis) {
      this.degraded = true;
      this.logger.warn('dashboard.cache.disabled.no_ioredis');
      return;
    }

    try {
      const Redis = ioredis.default;
      const cfg = this.config.redis;
      this.redis = new Redis({
        host: cfg.host,
        port: cfg.port,
        password: cfg.password,
        db: cfg.db,
        keyPrefix: cfg.keyPrefix,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      }) as unknown as RedisLike;
      this.redis.on('error', (err: Error) => {
        // Don't spam — first-error warn, the rest are silently swallowed.
        if (!this.degraded) {
          this.appLogger.warn('dashboard.cache.redis_error', { message: err.message });
        }
        this.degraded = true;
      });
    } catch (err) {
      this.degraded = true;
      this.appLogger.warn('dashboard.cache.init_failed', {
        message: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.quit();
    } catch {
      /* best-effort */
    }
    this.redis = null;
  }

  /** Inject a custom client (used by tests). */
  setClient(client: RedisLike | null): void {
    this.redis = client;
    this.degraded = client === null;
  }

  isDegraded(): boolean {
    return this.degraded || this.redis === null;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.redis || this.degraded) return null;
    try {
      const raw = await this.redis.get(this.fullKey(key));
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async set(
    key: string,
    value: unknown,
    ttlSeconds = DashboardCacheService.DEFAULT_TTL_SECONDS,
  ): Promise<void> {
    if (!this.redis || this.degraded) return;
    try {
      await this.redis.setex(this.fullKey(key), ttlSeconds, JSON.stringify(value));
    } catch {
      /* best-effort */
    }
  }

  async invalidate(pattern: string): Promise<number> {
    if (!this.redis || this.degraded) return 0;
    try {
      const keys = await this.redis.keys(this.fullKey(pattern));
      if (keys.length === 0) return 0;
      // Strip the configured `keyPrefix` because ioredis re-applies it
      // on `del` — `keys()` returns full keys *including* the prefix.
      const stripped = keys.map((k) => this.stripKeyPrefix(k));
      const removed = await this.redis.del(...stripped);
      return Number(removed) || 0;
    } catch {
      return 0;
    }
  }

  async invalidateStore(storeId: string): Promise<void> {
    await Promise.all([
      this.invalidate(`store:${storeId}:*`),
      this.invalidate(`user:*:${storeId}`),
    ]);
  }

  async invalidateTenant(tenantId: string): Promise<void> {
    await this.invalidate(`tenant:${tenantId}:*`);
  }

  /** Compose the in-app namespace prefix; the ioredis client adds the global prefix. */
  private fullKey(key: string): string {
    return `${DashboardCacheService.KEY_PREFIX}${key}`;
  }

  /**
   * `redis.keys()` returns keys with the ioredis-configured `keyPrefix`
   * already prepended (e.g. `radha:dashboard:store:foo`). `redis.del`
   * also re-applies the prefix, so we strip it from the lookup result
   * to avoid double-prefixing.
   */
  private stripKeyPrefix(fullKey: string): string {
    const cfg = this.config.redis.keyPrefix;
    if (cfg && fullKey.startsWith(cfg)) {
      return fullKey.slice(cfg.length);
    }
    return fullKey;
  }
}
