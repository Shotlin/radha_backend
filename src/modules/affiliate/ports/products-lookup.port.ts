/**
 * BE-41 — Products lookup port (re-export).
 *
 * The `HealthyAlternativesService` does NOT depend on the products
 * module directly. It consumes `ProductsLookupPort` — a thin
 * read-only port returning just the catalog fields we need (name,
 * brand, category, health score). This file is the canonical
 * import path for the port + DI token.
 *
 * The interface and DI symbol originate in `../types/affiliate.types`
 * (where the rest of the affiliate engine's public types live). This
 * module re-exports them so consumers — controllers, modules,
 * tests, and any future real adapter — can import from a stable
 * `ports/` location instead of reaching into `types/`.
 *
 * Concrete adapters:
 *   - `StubProductsLookupAdapter` (in-memory fixture, default binding;
 *     see `services/stub-products-lookup.adapter.ts`).
 *   - A real adapter delegating to the products + health-scoring
 *     modules can be plugged in later via the `PRODUCTS_LOOKUP_PORT`
 *     DI token.
 */

export {
  PRODUCTS_LOOKUP_PORT,
  type FindHealthierOptions,
  type ProductCatalogEntry,
  type ProductsLookupPort,
} from '../types/affiliate.types';
