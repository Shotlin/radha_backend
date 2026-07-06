import { Injectable, Logger } from '@nestjs/common';

import type {
  FindHealthierOptions,
  ProductCatalogEntry,
  ProductsLookupPort,
} from '../types/affiliate.types';

/**
 * BE-41 — In-memory `ProductsLookupPort` adapter.
 *
 * Used as the default binding for `PRODUCTS_LOOKUP_PORT` until a real
 * adapter against the products + health-scoring modules is wired in.
 *
 * Tests can swap in their own adapter; production code can extend
 * this class or replace the binding at module level. Keeping the stub
 * deliberately simple lets the `HealthyAlternativesService` ship and
 * be exercised end-to-end without committing to a particular
 * persistence model.
 */
@Injectable()
export class StubProductsLookupAdapter implements ProductsLookupPort {
  private readonly logger = new Logger(StubProductsLookupAdapter.name);
  private readonly catalog = new Map<string, ProductCatalogEntry>();

  /**
   * Test/dev seed hook — replace the in-memory catalog atomically.
   * Returns the adapter so callers can chain in `beforeEach`.
   */
  seed(entries: ProductCatalogEntry[]): this {
    this.catalog.clear();
    for (const entry of entries) {
      this.catalog.set(entry.ean, entry);
    }
    this.logger.debug(`Seeded ${entries.length} catalog entries`);
    return this;
  }

  async findByEan(ean: string): Promise<ProductCatalogEntry | null> {
    return this.catalog.get(ean) ?? null;
  }

  async findHealthierThan(
    sourceEan: string,
    options: FindHealthierOptions = {},
  ): Promise<ProductCatalogEntry[]> {
    const limit = options.limit ?? 3;
    const minDelta = options.minDelta ?? 0;
    const source = this.catalog.get(sourceEan);
    if (!source) return [];

    return [...this.catalog.values()]
      .filter((c) => c.ean !== source.ean)
      .filter((c) => c.categoryId !== null && c.categoryId === source.categoryId)
      .filter((c) => c.healthScore >= source.healthScore + minDelta)
      .sort((a, b) => b.healthScore - a.healthScore)
      .slice(0, limit);
  }
}
