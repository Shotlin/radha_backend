import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import type {
  IProductDataProvider,
  ProductLookupHit,
} from '@/integrations/products/product-provider.types';
import { CircuitBreakerService } from '@/integrations/products/circuit-breaker.service';

import { OpfCacheService } from './opf-cache.service';
import { OpfMapperService } from './opf-mapper.service';
import {
  OPF_API_VERSION,
  OPF_BASE_URL,
  OPF_CB_FAILURE_THRESHOLD,
  OPF_CB_OPEN_DURATION_MS,
  OPF_CB_SUCCESS_THRESHOLD,
  OPF_REQUEST_TIMEOUT_MS,
  OPF_USER_AGENT,
} from './opf.constants';
import type { OpfApiResponse, OpfProduct, OpfStats } from './opf.types';

/**
 * RADHA's entry point into the Open Products Facts API
 * (household / general merchandise). Tried after Open Beauty Facts
 * misses, before UPCitemdb — see `ProductProviderRegistryService`.
 *
 * Mirrors `OpenFoodFactsService` / `OpenBeautyFactsService`'s
 * cache → circuit-breaker → fetch → negative-cache shape, with its
 * own isolated cache table and circuit breaker instance.
 */
@Injectable()
export class OpenProductsFactsService implements IProductDataProvider {
  readonly providerName = 'open_products_facts' as const;

  private readonly breaker: CircuitBreakerService;
  private totalRequests = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private apiSuccess = 0;
  private apiFailures = 0;
  private readonly responseTimes: number[] = [];

  constructor(
    private readonly cache: OpfCacheService,
    private readonly mapper: OpfMapperService,
    private readonly logger: LoggerService,
  ) {
    this.breaker = new CircuitBreakerService(
      logger,
      'open_products_facts',
      OPF_CB_FAILURE_THRESHOLD,
      OPF_CB_SUCCESS_THRESHOLD,
      OPF_CB_OPEN_DURATION_MS,
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
        `${OPF_BASE_URL}/api/${OPF_API_VERSION}/product/3017620422003.json`,
      );
      return r.ok;
    } catch {
      return false;
    }
  }

  getStats(): OpfStats {
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

  private async fetchRaw(ean: string): Promise<OpfProduct | null> {
    this.totalRequests += 1;

    const cached = await this.cache.get(ean);
    if (cached) {
      this.cacheHits += 1;
      this.logger.debug('opf.cache.hit', { ean, fetchSuccess: cached.fetchSuccess });
      return cached.product;
    }
    this.cacheMisses += 1;

    if (!this.breaker.isAllowed()) {
      this.logger.warn('opf.circuit.short_circuit', { ean });
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
      this.logger.error('opf.api.failed', {
        ean,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return null;
    }
  }

  /** Test seam — overridden in unit tests to avoid live HTTP. */
  protected async request(url: string): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), OPF_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': OPF_USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }

  private async fetchByEan(ean: string): Promise<OpfProduct | null> {
    const url = `${OPF_BASE_URL}/api/${OPF_API_VERSION}/product/${ean}.json`;
    const res = await this.request(url);
    if (!res.ok) {
      throw new Error(`OPF API returned ${res.status}`);
    }
    const body = (await res.json()) as OpfApiResponse;
    if (body.status !== 1 || !body.product) return null;
    return body.product;
  }
}
