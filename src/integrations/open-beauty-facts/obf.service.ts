import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import type {
  IProductDataProvider,
  ProductLookupHit,
} from '@/integrations/products/product-provider.types';
import { CircuitBreakerService } from '@/integrations/products/circuit-breaker.service';

import { ObfCacheService } from './obf-cache.service';
import { ObfMapperService } from './obf-mapper.service';
import {
  OBF_API_VERSION,
  OBF_BASE_URL,
  OBF_CB_FAILURE_THRESHOLD,
  OBF_CB_OPEN_DURATION_MS,
  OBF_CB_SUCCESS_THRESHOLD,
  OBF_REQUEST_TIMEOUT_MS,
  OBF_USER_AGENT,
} from './obf.constants';
import type { ObfApiResponse, ObfProduct, ObfStats } from './obf.types';

/**
 * RADHA's entry point into the Open Beauty Facts API (cosmetics /
 * personal care). Tried after Open Food Facts misses, before Open
 * Products Facts — see `ProductProviderRegistryService`.
 *
 * Mirrors `OpenFoodFactsService`'s cache → circuit-breaker → fetch →
 * negative-cache shape, with its own isolated cache table and circuit
 * breaker instance so an OBF outage can't trip OFF's breaker or vice
 * versa.
 */
@Injectable()
export class OpenBeautyFactsService implements IProductDataProvider {
  readonly providerName = 'open_beauty_facts' as const;

  private readonly breaker: CircuitBreakerService;
  private totalRequests = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private apiSuccess = 0;
  private apiFailures = 0;
  private readonly responseTimes: number[] = [];

  constructor(
    private readonly cache: ObfCacheService,
    private readonly mapper: ObfMapperService,
    private readonly logger: LoggerService,
  ) {
    this.breaker = new CircuitBreakerService(
      logger,
      'open_beauty_facts',
      OBF_CB_FAILURE_THRESHOLD,
      OBF_CB_SUCCESS_THRESHOLD,
      OBF_CB_OPEN_DURATION_MS,
    );
  }

  async lookupByEan(ean: string): Promise<ProductLookupHit | null> {
    const product = await this.fetchRaw(ean);
    if (!product) return null;
    return {
      mapped: this.mapper.mapToProduct(product),
      nutrition: this.mapper.mapToNutrition(product),
    };
  }

  async isHealthy(): Promise<boolean> {
    try {
      const r = await this.request(
        `${OBF_BASE_URL}/api/${OBF_API_VERSION}/product/3017620422003.json`,
      );
      return r.ok;
    } catch {
      return false;
    }
  }

  getStats(): ObfStats {
    const avg =
      this.responseTimes.length > 0
        ? Math.round(this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length)
        : 0;
    return {
      totalRequests: this.totalRequests,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      apiSuccess: this.apiSuccess,
      apiFailures: this.apiFailures,
      circuitState: this.breaker.getState(),
      averageResponseMs: avg,
    };
  }

  private async fetchRaw(ean: string): Promise<ObfProduct | null> {
    this.totalRequests += 1;

    const cached = await this.cache.get(ean);
    if (cached) {
      this.cacheHits += 1;
      this.logger.debug('obf.cache.hit', { ean, fetchSuccess: cached.fetchSuccess });
      return cached.product;
    }
    this.cacheMisses += 1;

    if (!this.breaker.isAllowed()) {
      this.logger.warn('obf.circuit.short_circuit', { ean });
      return null;
    }

    const start = Date.now();
    try {
      const product = await this.fetchByEan(ean);
      this.responseTimes.push(Date.now() - start);
      if (this.responseTimes.length > 100) this.responseTimes.shift();
      this.breaker.recordSuccess();
      this.apiSuccess += 1;

      if (product) {
        await this.cache.setHit(ean, product);
      } else {
        await this.cache.setMiss(ean);
      }
      return product;
    } catch (err) {
      this.breaker.recordFailure();
      this.apiFailures += 1;
      this.logger.error('obf.api.failed', {
        ean,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return null;
    }
  }

  /** Test seam — overridden in unit tests to avoid live HTTP. */
  protected async request(url: string): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), OBF_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': OBF_USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }

  private async fetchByEan(ean: string): Promise<ObfProduct | null> {
    const url = `${OBF_BASE_URL}/api/${OBF_API_VERSION}/product/${ean}.json`;
    const res = await this.request(url);
    if (!res.ok) {
      throw new Error(`OBF API returned ${res.status}`);
    }
    const body = (await res.json()) as ObfApiResponse;
    if (body.status !== 1 || !body.product) return null;
    return body.product;
  }
}
