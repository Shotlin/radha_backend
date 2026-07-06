import { Injectable } from '@nestjs/common';

import type { ProductRow } from '@/db/schema/products';

import { AutocompleteDto, SearchProductsDto } from '../dto/search.dto';
import { SearchRepository } from '../repositories/search.repository';
import type { AutocompleteResult, SearchFacets, SearchResult } from '../types/search.types';
import { sanitiseQuery } from '../utils/search-query.utils';

import { SearchAnalyticsService } from './search-analytics.service';

/**
 * BE-14 — Product search orchestrator.
 *
 *   - `search()` runs the FTS+trigram+filter query and returns a
 *     paginated, optionally faceted, ranked result set.
 *   - `autocomplete()` returns prefix-and-similarity suggestions.
 *   - `getFacets()` is reusable — controllers can call it directly to
 *     surface filters for an empty-search landing page.
 *   - `getPopular()` reads from the BE-14 `popular_products` ledger.
 *   - `findSimilar()` powers duplicate-detection + "also viewed" UIs.
 *
 * Tier-aware caps (Req 39: top-20 cap for Free) are enforced in the
 * controller layer via `PermissionsService.getEntitlements`. This
 * service simply respects whatever `limit` it receives.
 */
@Injectable()
export class ProductSearchService {
  constructor(
    private readonly searchRepo: SearchRepository,
    private readonly analytics: SearchAnalyticsService,
  ) {}

  async search(
    query: SearchProductsDto,
    tenantId: string | null,
    userId: string | null,
  ): Promise<SearchResult> {
    const start = Date.now();
    const cleanedQuery = sanitiseQuery(query.q ?? '');

    const result = await this.searchRepo.fullTextSearch({
      rawQuery: cleanedQuery,
      tenantId,
      filters: {
        ean: query.ean,
        brand: query.brand,
        category: query.category,
        healthGrades: query.healthGrade,
        childSafe: query.childSafe,
        excludeProcessed: query.excludeProcessed,
        status: query.status,
      },
      cursor: query.cursor,
      limit: query.limit,
      orderBy: query.orderBy,
    });

    let facets: SearchFacets | undefined;
    if (query.includeFacets) {
      facets = await this.searchRepo.getFacets(tenantId);
    }

    const durationMs = Date.now() - start;

    if (cleanedQuery.length > 0) {
      this.analytics.track({
        query: cleanedQuery,
        tenantId,
        userId,
        resultCount: result.total,
        durationMs,
        source: 'search',
      });
    }

    return {
      data: result.data,
      total: result.total,
      nextCursor: result.nextCursor,
      facets,
      query: cleanedQuery,
      durationMs,
    };
  }

  async autocomplete(
    query: AutocompleteDto,
    tenantId: string | null,
    userId: string | null,
  ): Promise<AutocompleteResult> {
    const start = Date.now();
    const seeds = await this.searchRepo.autocomplete(query.q, tenantId, query.limit);
    const durationMs = Date.now() - start;

    this.analytics.track({
      query: query.q,
      tenantId,
      userId,
      resultCount: seeds.length,
      durationMs,
      source: 'autocomplete',
    });

    return {
      suggestions: seeds.map((s) => ({
        text: s.matchedField === 'brand' && s.brand ? s.brand : s.name,
        type: 'product',
        productId: s.id,
        matchedField: s.matchedField,
      })),
      durationMs,
    };
  }

  async getFacets(tenantId: string | null): Promise<SearchFacets> {
    return this.searchRepo.getFacets(tenantId);
  }

  async getPopular(tenantId: string | null, limit: number): Promise<ProductRow[]> {
    return this.searchRepo.getPopular(tenantId, limit);
  }

  async findSimilar(productId: string, tenantId: string | null, limit = 10): Promise<ProductRow[]> {
    return this.searchRepo.findSimilar(productId, tenantId, limit);
  }

  /** Used by the BE-15 scan pipeline to bump popularity on every scan. */
  async recordScan(productId: string, tenantId: string | null): Promise<void> {
    await this.searchRepo.incrementPopularity(productId, tenantId, { scans: 1 });
  }
}
