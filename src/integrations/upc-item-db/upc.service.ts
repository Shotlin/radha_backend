import { Inject, Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import type {
  IProductDataProvider,
  ProductLookupHit,
} from '@/integrations/products/product-provider.types';
import { CircuitBreakerService } from '@/integrations/products/circuit-breaker.service';
import { REDIS_QUOTA_PORT, RedisQuotaPort } from '@/modules/rate-limiting/ports/redis-quota.port';

import { UpcMapperService } from './upc-mapper.service';
import { UpcQuotaGuard } from './upc-quota.guard';
import {
  UPC_BASE_URL,
  UPC_NEGATIVE_CACHE_TTL_SECONDS,
  UPC_REQUEST_TIMEOUT_MS,
  UPC_USER_AGENT,
} from './upc.constants';
import type { UpcItem, UpcLookupResponse, UpcStats } from './upc.types';

/**
 * RADHA's entry point into the UPCitemdb trial API — the generic,
 * last-resort fallback tried after Open Food/Beauty/Products Facts
 * all miss. See `ProductProviderRegistryService` for ordering.
 *
 * Two safeguards beyond the usual circuit breaker, both because the
 * free tier is only 100 *combined* requests/day across every user:
 *   - `UpcQuotaGuard` — hard daily cap, checked BEFORE any network call.
 *   - A Redis-backed negative cache (`upc_miss:<ean>`, 24h TTL) so a
 *     barcode UPCitemdb doesn't have isn't re-queried (and re-billed
 *     against the quota) every time a different user scans it the
 *     same day. Reuses the same `RedisQuotaPort` the quota guard uses
 *     — no new infra for this.
 */
@Injectable()
export class UpcItemDbService implements IProductDataProvider {
  readonly providerName = 'upc_item_db' as const;

  private readonly breaker: CircuitBreakerService;
  private totalRequests = 0;
  private quotaSkips = 0;
  private negativeCacheHits = 0;
  private apiSuccess = 0;
  private apiFailures = 0;

  constructor(
    private readonly quota: UpcQuotaGuard,
    private readonly mapper: UpcMapperService,
    private readonly logger: LoggerService,
    @Inject(REDIS_QUOTA_PORT) private readonly redis: RedisQuotaPort,
  ) {
    this.breaker = new CircuitBreakerService(logger, 'upc_item_db');
  }

  async lookupByEan(ean: string): Promise<ProductLookupHit | null> {
    this.totalRequests += 1;

    const missKey = `upc_miss:${ean}`;
    const alreadyMissed = await this.redis.get(missKey).catch(() => null);
    if (alreadyMissed) {
      this.negativeCacheHits += 1;
      this.logger.debug('upc.negative_cache.hit', { ean });
      return null;
    }

    if (!this.breaker.isAllowed()) {
      this.logger.warn('upc.circuit.short_circuit', { ean });
      return null;
    }

    const allowed = await this.quota.tryConsume();
    if (!allowed) {
      this.quotaSkips += 1;
      this.logger.debug('upc.quota.skipped', { ean });
      return null;
    }

    try {
      const item = await this.fetchByEan(ean);
      this.breaker.recordSuccess();
      this.apiSuccess += 1;

      if (!item) {
        await this.recordMiss(missKey);
        return null;
      }
      return {
        mapped: this.mapper.mapToProduct(item, ean),
        nutrition: this.mapper.mapToNutrition(item),
      };
    } catch (err) {
      this.breaker.recordFailure();
      this.apiFailures += 1;
      this.logger.error('upc.api.failed', {
        ean,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return null;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const r = await this.request(`${UPC_BASE_URL}/lookup?upc=049000028911`);
      return r.ok;
    } catch {
      return false;
    }
  }

  getStats(): UpcStats {
    return {
      totalRequests: this.totalRequests,
      quotaSkips: this.quotaSkips,
      negativeCacheHits: this.negativeCacheHits,
      apiSuccess: this.apiSuccess,
      apiFailures: this.apiFailures,
      circuitState: this.breaker.getState(),
    };
  }

  private async recordMiss(missKey: string): Promise<void> {
    try {
      await this.redis.incr(missKey);
      await this.redis.expire(missKey, UPC_NEGATIVE_CACHE_TTL_SECONDS);
    } catch {
      /* best-effort — worst case we re-query this EAN once more before quota runs out */
    }
  }

  /** Test seam — overridden in unit tests to avoid live HTTP. */
  protected async request(url: string): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), UPC_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': UPC_USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }

  private async fetchByEan(ean: string): Promise<UpcItem | null> {
    const url = `${UPC_BASE_URL}/lookup?upc=${encodeURIComponent(ean)}`;
    const res = await this.request(url);
    if (!res.ok) {
      throw new Error(`UPCitemdb API returned ${res.status}`);
    }
    const body = (await res.json()) as UpcLookupResponse;
    if (body.code !== 'OK' || !body.items || body.items.length === 0) return null;
    return body.items[0];
  }
}
