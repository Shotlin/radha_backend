/**
 * BE-45 — Catalog lookup port for the image OCR fallback.
 *
 * The fallback service shouldn't know whether catalog matches come
 * from `ProductsRepository`, a search index, or a future
 * vector-similarity service — it just asks "do you have a product
 * for this name + brand?". Tests inject a stub; production wiring
 * binds the symbol to a Drizzle-backed adapter via the module
 * factory.
 */

export interface ProductsLookupResult {
  /** Universal EAN (13 digits) of the matched product. */
  ean: string;
  /** Display name of the matched product (post-normalisation). */
  name: string;
  /** Brand of the matched product (when known). */
  brand?: string;
}

export interface IProductsLookupPort {
  /**
   * Look up a product by OCR'd `name` + `brand`. Implementations
   * should normalise inputs (case-fold, trim, strip noise) and may
   * apply fuzzy matching. Return `null` when no confident match
   * exists — the caller will fall back to OFF.
   */
  findByNameBrand(input: {
    name: string;
    brand?: string;
  }): Promise<ProductsLookupResult | null>;
}

export const PRODUCTS_LOOKUP_PORT = Symbol('PRODUCTS_LOOKUP_PORT');
