import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';
import { LoggerService } from '@/logging/logger.service';

import type { RedisQuotaPort } from '../ports/redis-quota.port';

type RedisLike = {
  incr(key: string): Promise<number | string>;
  expire(key: string, seconds: number): Promise<number | string>;
  get(key: string): Promise<string | null>;
  quit(): Promise<unknown>;
  on(event: string, listener: (err: Error) => void): void;
};

/**
 * BE-46 — Production binding for `RedisQuotaPort` over `ioredis`.
 *
 * Mirrors the lazy-load + degrade pattern from BE-30's dashboard
 * cache:
 *   - `ioredis` is `await import(...)`-ed so unit tests / Redis-less
 *     dev environments still boot.
 *   - First connection error flips the adapter to `degraded` and
 *     every subsequent call becomes a no-op (logged once).
 *   - The narrow `RedisQuotaPort` surface (`incr`, `expire`, `get`)
 *     is the only part of `ioredis` we need; we don't lock the rest
 *     of the module to the SDK.
 *
 * Resilience contract: when degraded, `incr` returns 0. The service
 * treats that as "counter unavailable" and fails open while logging
 * a warning — matching the BE-46 SOP decision (fail open, audited).
 */
@Injectable()
export class IoRedisQuotaAdapter implements RedisQuotaPort, OnModuleInit, OnModuleDestroy {
  private redis: RedisLike | null = null;
  private degraded = false;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
  ) {}

  async onModuleInit(): Promise<void> {
    type IoRedisModule = typeof import('ioredis');
    const ioredis = (await import('ioredis').catch(() => null)) as IoRedisModule | null;
    if (!ioredis) {
      this.degraded = true;
      this.logger.warn('rate_limit.redis.disabled.no_ioredis');
      return;
    }
    try {
      const Redis = ioredis.default;
      const cfg = this.config.redis;
      const client = new Redis({
        host: cfg.host,
        port: cfg.port,
        password: cfg.password,
        db: cfg.db,
        keyPrefix: cfg.keyPrefix,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      }) as unknown as RedisLike;
      client.on('error', (err: Error) => {
        if (!this.degraded) {
          this.logger.warn('rate_limit.redis.error', { message: err.message });
        }
        this.degraded = true;
      });
      this.redis = client;
    } catch (err) {
      this.degraded = true;
      this.logger.warn('rate_limit.redis.init_failed', {
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

  async incr(key: string): Promise<number> {
    if (!this.redis || this.degraded) return 0;
    try {
      const v = await this.redis.incr(key);
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    } catch {
      this.degraded = true;
      return 0;
    }
  }

  async expire(key: string, seconds: number): Promise<void> {
    if (!this.redis || this.degraded) return;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    try {
      await this.redis.expire(key, seconds);
    } catch {
      /* best-effort */
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.redis || this.degraded) return null;
    try {
      return (await this.redis.get(key)) ?? null;
    } catch {
      return null;
    }
  }

  async quit(): Promise<void> {
    await this.onModuleDestroy();
  }

  /** Test seam: inject a custom client (mirrors BE-30 pattern). */
  setClient(client: RedisLike | null): void {
    this.redis = client;
    this.degraded = client === null;
  }
}
