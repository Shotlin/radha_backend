/**
 * BE-41 — Affiliate engine public types.
 *
 * The healthy-alternatives service does NOT depend on the products
 * module directly. Instead it consumes a `ProductsLookupPort` —
 * a thin read-only port that returns just the catalog fields we need
 * (name, brand, category, health score). The concrete adapter wiring
 * lives in `affiliate.module.ts` and currently uses a stub
 * implementation; a real adapter against the products + health-scoring
 * modules can be wired in later without touching the service.
 */

export interface ProductCatalogEntry {
  ean: string;
  name: string;
  brand: string | null;
  categoryId: string | null;
  healthScore: number;
}

export interface FindHealthierOptions {
  /** Maximum number of candidates to return. Default 3. */
  limit?: number;
  /**
   * Minimum score delta over the source product. Candidates whose
   * health score is not at least `sourceScore + minDelta` are
   * filtered out so we never recommend a product that is only
   * marginally healthier.
   */
  minDelta?: number;
}

/**
 * Read-only port consumed by `HealthyAlternativesService`.
 *
 * Implementations:
 *   - `StubProductsLookupAdapter` (in-memory fixture, used by default
 *     and by tests) — see `services/stub-products-lookup.adapter.ts`.
 *   - A real adapter delegating to the products + health-scoring
 *     modules can be plugged in later via the `PRODUCTS_LOOKUP_PORT`
 *     DI token.
 */
export interface ProductsLookupPort {
  findByEan(ean: string): Promise<ProductCatalogEntry | null>;
  findHealthierThan(
    sourceEan: string,
    options?: FindHealthierOptions,
  ): Promise<ProductCatalogEntry[]>;
}

export const PRODUCTS_LOOKUP_PORT = Symbol('PRODUCTS_LOOKUP_PORT');
