import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import { OffCacheService } from './off-cache.service';
import { OffCircuitBreakerService } from './off-circuit-breaker.service';
import {
  OFF_API_VERSION,
  OFF_BASE_URL,
  OFF_REQUEST_TIMEOUT_MS,
  OFF_SEARCH_FIELDS,
  OFF_SEARCH_MAX_PAGE_SIZE,
  OFF_USER_AGENT,
} from './off.constants';
import type { OffApiResponse, OffProduct, OffSearchResponse, OffStats } from './off.types';

/**
 * RADHA's only entry point into the Open Food Facts API.
 *
 *   - Always checks `OffCacheService` first.
 *   - Respects `OffCircuitBreakerService` — when the circuit is open,
 *     skips the network entirely and returns `null`. The Mobile_App
 *     gracefully falls back to `found: false` rather than seeing a 502.
 *   - Negative-caches OFF "product not found" so repeat misses don't
 *     hammer the upstream service.
 *   - Tracks `OffStats` for the BE-31 admin dashboard (cache hit ratio,
 *     average response time, circuit state).
 */
@Injectable()
export class OpenFoodFactsService {
  private totalRequests = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private apiSuccess = 0;
  private apiFailures = 0;
  private readonly responseTimes: number[] = [];

  constructor(
    private readonly cache: OffCacheService,
    private readonly breaker: OffCircuitBreakerService,
    private readonly logger: LoggerService,
  ) {}

  async lookupByEan(ean: string): Promise<OffProduct | null> {
    this.totalRequests += 1;

    const cached = await this.cache.get(ean);
    if (cached) {
      this.cacheHits += 1;
      this.logger.debug('off.cache.hit', { ean, fetchSuccess: cached.fetchSuccess });
      return cached.product;
    }
    this.cacheMisses += 1;

    if (!this.breaker.isAllowed()) {
      this.logger.warn('off.circuit.short_circuit', { ean });
      return null;
    }

    const start = Date.now();
    try {
      const product = await this.fetchByEanWithRetry(ean);
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
      this.logger.error('off.api.failed', {
        ean,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return null;
    }
  }

  /**
   * One immediate retry on a transient failure (timeout/abort, network
   * error, 5xx). A single 5s attempt turned every OFF blip into a
   * user-visible "product not found" — which then "worked" on the next
   * scan, the exact sometimes-found-sometimes-not flakiness reported
   * from the field. A genuine OFF miss (`status !== 1`) is NOT a
   * failure and is never retried, so the extra attempt only spends
   * time when the first one didn't produce an answer at all.
   */
  private async fetchByEanWithRetry(ean: string): Promise<OffProduct | null> {
    try {
      return await this.fetchByEan(ean);
    } catch (err) {
      this.logger.warn('off.api.retrying_once', {
        ean,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return this.fetchByEan(ean);
    }
  }

  /**
   * Fetch a page of products in an OFF category, optionally scoped to a
   * country. Powers the BE catalog bulk-import (browse-without-scan data) — the
   * single-EAN {@link lookupByEan} path is unsuitable for bulk seeding.
   *
   * Respects the circuit breaker and never throws: a failed/short-circuited
   * fetch returns `[]` so the importer simply moves to the next page/category.
   * Every fetched product is written to the OFF cache so later single lookups
   * are warm.
   */
  async searchByCategory(
    category: string,
    options: { page?: number; pageSize?: number; country?: string } = {},
  ): Promise<OffProduct[]> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(options.pageSize ?? 50, OFF_SEARCH_MAX_PAGE_SIZE);
    const country = options.country ?? 'india';

    this.totalRequests += 1;

    if (!this.breaker.isAllowed()) {
      this.logger.warn('off.search.circuit.short_circuit', { category, page });
      return [];
    }

    const params = new URLSearchParams({
      action: 'process',
      json: '1',
      page: String(page),
      page_size: String(pageSize),
      sort_by: 'unique_scans_n',
      tagtype_0: 'categories',
      tag_contains_0: 'contains',
      tag_0: category,
      tagtype_1: 'countries',
      tag_contains_1: 'contains',
      tag_1: country,
      fields: OFF_SEARCH_FIELDS,
    });
    const url = `${OFF_BASE_URL}/cgi/search.pl?${params.toString()}`;

    const start = Date.now();
    try {
      const res = await this.request(url);
      if (!res.ok) throw new Error(`OFF search returned ${res.status}`);
      const body = (await res.json()) as OffSearchResponse;

      this.responseTimes.push(Date.now() - start);
      if (this.responseTimes.length > 100) this.responseTimes.shift();
      this.breaker.recordSuccess();
      this.apiSuccess += 1;

      const products = Array.isArray(body.products) ? body.products : [];
      // Warm the cache so a later single lookup of the same EAN is a hit.
      for (const product of products) {
        if (product.code) {
          await this.cache.setHit(product.code, product).catch(() => undefined);
        }
      }
      return products;
    } catch (err) {
      this.breaker.recordFailure();
      this.apiFailures += 1;
      this.logger.error('off.search.failed', {
        category,
        page,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return [];
    }
  }

  /**
   * Free-text product search (OFF `search_terms`), optionally scoped to a
   * country. Used by the **curated** catalog seed to resolve a real market
   * barcode for a known product (brand + name) instead of guessing one.
   *
   * Mirrors {@link searchByCategory}'s robustness: respects the circuit
   * breaker, never throws (returns `[]`), and warms the EAN cache for every
   * row so a later single lookup is a hit.
   */
  async searchByText(
    terms: string,
    options: { page?: number; pageSize?: number; country?: string } = {},
  ): Promise<OffProduct[]> {
    const query = terms.trim();
    if (query.length === 0) return [];

    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(options.pageSize ?? 20, OFF_SEARCH_MAX_PAGE_SIZE);
    const country = options.country ?? 'india';

    this.totalRequests += 1;

    if (!this.breaker.isAllowed()) {
      this.logger.warn('off.text_search.circuit.short_circuit', { query, page });
      return [];
    }

    const params = new URLSearchParams({
      action: 'process',
      json: '1',
      page: String(page),
      page_size: String(pageSize),
      sort_by: 'unique_scans_n',
      search_terms: query,
      tagtype_0: 'countries',
      tag_contains_0: 'contains',
      tag_0: country,
      fields: OFF_SEARCH_FIELDS,
    });
    const url = `${OFF_BASE_URL}/cgi/search.pl?${params.toString()}`;

    const start = Date.now();
    try {
      const res = await this.request(url);
      if (!res.ok) throw new Error(`OFF text search returned ${res.status}`);
      const body = (await res.json()) as OffSearchResponse;

      this.responseTimes.push(Date.now() - start);
      if (this.responseTimes.length > 100) this.responseTimes.shift();
      this.breaker.recordSuccess();
      this.apiSuccess += 1;

      const products = Array.isArray(body.products) ? body.products : [];
      for (const product of products) {
        if (product.code) {
          await this.cache.setHit(product.code, product).catch(() => undefined);
        }
      }
      return products;
    } catch (err) {
      this.breaker.recordFailure();
      this.apiFailures += 1;
      this.logger.error('off.text_search.failed', {
        query,
        page,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return [];
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const r = await this.request(
        `${OFF_BASE_URL}/api/${OFF_API_VERSION}/product/3017620422003.json`,
      );
      return r.ok;
    } catch {
      return false;
    }
  }

  getStats(): OffStats {
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

  /** Test seam — overridden in unit tests to avoid live HTTP. */
  protected async request(url: string): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), OFF_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': OFF_USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }

  private async fetchByEan(ean: string): Promise<OffProduct | null> {
    const url = `${OFF_BASE_URL}/api/${OFF_API_VERSION}/product/${ean}.json`;
    const res = await this.request(url);
    if (!res.ok) {
      throw new Error(`OFF API returned ${res.status}`);
    }
    const body = (await res.json()) as OffApiResponse;
    if (body.status !== 1 || !body.product) return null;
    return body.product;
  }
}
