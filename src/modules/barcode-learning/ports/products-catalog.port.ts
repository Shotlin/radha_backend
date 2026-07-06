import { Injectable, Logger } from '@nestjs/common';

/**
 * BE-56 — Minimal `Product_Catalog` surface required by the
 * Barcode Learning service.
 *
 * Why a port? The community submission flow upserts a global product
 * (`tenant_id = NULL`) into the catalog as the moderator approves it.
 * That write is owned by `BE-10 / BE-11` (`ProductsRepository.upsert`)
 * — which BE-11 v2 will surface as a higher-level service. To keep
 * BE-56 testable and decoupled until then, we depend on a tiny
 * port the BE-11 wiring step rebinds in production.
 *
 * The default binding is the `StubProductsCatalogAdapter` below: it
 * logs the would-be upsert and returns a deterministic synthetic id.
 * Tests inject their own implementation; the real adapter ships
 * alongside BE-11 v2's catalog service.
 */
export interface ProductsCatalogPort {
  /**
   * Upsert (insert-or-update) a global, public catalog row keyed on
   * `ean`. Implementations must be idempotent on `ean` — re-approving
   * a duplicate submission for the same EAN should update, not
   * insert a second row.
   *
   * Returns the canonical product id so the caller can attach an
   * audit log entry.
   */
  upsertGlobal(input: ProductsCatalogUpsertInput): Promise<ProductsCatalogUpsertResult>;
}

export interface ProductsCatalogUpsertInput {
  ean: string;
  brand?: string | null;
  name?: string | null;
  category?: string | null;
  /**
   * BE-56 v3 — the label's INGREDIENTS list. Adapters persist it to
   * `products.description`, the same field OFF `ingredients_text`
   * already maps to, so the health/ingredient-explainer features see
   * community products exactly like OFF ones.
   */
  ingredients?: string | null;
  /**
   * BE-56 v3 — public URL for the product image (typically the CDN
   * URL of the first approved submission photo). Persisted to
   * `products.imageUrl`.
   */
  imageUrl?: string | null;
  /**
   * S3 keys for any attached product images. The catalog service
   * decides whether to expose these via CloudFront or stash them as
   * metadata.
   */
  s3ObjectKeys?: string[] | null;
  /**
   * BE-56 v2 — nutrition panel to attach to the catalog product.
   * Plain numbers at the port boundary (decimal-string conversion is
   * an adapter/persistence concern, same as `nutritionToRow` in
   * `products.service.ts`). Omitted when the submission carried no
   * nutrition data.
   */
  nutrition?: ProductsCatalogNutritionInput | null;
  /**
   * Where the upsert is coming from. BE-56 always sets `'community'`,
   * but BE-11 v2 may reuse the same port for OFF-driven upserts.
   */
  source: 'community' | 'open_food_facts' | 'manual';
  /** The user who submitted the product. */
  submitterUserId?: string | null;
  /** The moderator that approved the upsert. */
  approvedBy?: string | null;
}

export interface ProductsCatalogNutritionInput {
  servingSize?: number;
  servingUnit?: string;
  calories?: number;
  protein?: number;
  carbohydrates?: number;
  sugars?: number;
  fat?: number;
  saturatedFat?: number;
  transFat?: number;
  fiber?: number;
  sodium?: number;
}

export interface ProductsCatalogUpsertResult {
  productId: string;
  /** True when the catalog created a new row, false when it updated. */
  created: boolean;
}

/** DI token. Bound to `StubProductsCatalogAdapter` by the module. */
export const PRODUCTS_CATALOG_PORT = Symbol('PRODUCTS_CATALOG_PORT');

/**
 * BE-56 — Stub adapter for the `ProductsCatalogPort`.
 *
 * Logs the upsert and returns a deterministic synthetic id derived
 * from the EAN so the rest of the moderation flow can complete in
 * dev / test environments without the BE-11 v2 catalog service
 * being wired up. The real adapter (BE-11 v2) replaces this binding
 * via `useExisting` in `BarcodeLearningModule`.
 */
@Injectable()
export class StubProductsCatalogAdapter implements ProductsCatalogPort {
  private readonly logger = new Logger(StubProductsCatalogAdapter.name);

  /**
   * Track which EANs we've "seen" so the second call for the same
   * EAN reports `created: false` — matches the contract documented
   * for the real catalog adapter.
   */
  private readonly seenEans = new Set<string>();

  async upsertGlobal(input: ProductsCatalogUpsertInput): Promise<ProductsCatalogUpsertResult> {
    const created = !this.seenEans.has(input.ean);
    this.seenEans.add(input.ean);

    this.logger.log(
      `stub.products_catalog.upsert ean=${input.ean} created=${created} source=${input.source}`,
    );

    return {
      // Synthetic deterministic id — the real catalog returns the
      // `products.id` UUID. Tests should never depend on this value;
      // they typically inject their own mock adapter.
      productId: `stub-${input.ean}`,
      created,
    };
  }
}
