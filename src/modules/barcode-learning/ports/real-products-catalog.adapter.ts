import { Injectable, Logger } from '@nestjs/common';

import { NewProduct } from '@/db/schema/products';
import { ProductCategoriesRepository } from '@/modules/products/repositories/product-categories.repository';
import { ProductNutritionRepository } from '@/modules/products/repositories/product-nutrition.repository';
import { ProductsRepository } from '@/modules/products/products.repository';

import {
  ProductsCatalogNutritionInput,
  ProductsCatalogPort,
  ProductsCatalogUpsertInput,
  ProductsCatalogUpsertResult,
} from './products-catalog.port';

/**
 * BE-56 v2 — real `ProductsCatalogPort` adapter.
 *
 * Replaces `StubProductsCatalogAdapter`. Composes the existing,
 * already-tested `ProductsRepository.upsertGlobalByEan()` and
 * `ProductNutritionRepository.upsertForProduct()` — no new insert
 * logic, so approvals land in the exact same global (`tenant_id =
 * NULL`) catalog rows the product-lookup chain already checks first.
 *
 * `category` on the submission is free text; `products.categoryId`
 * is a FK, so we resolve/create it via
 * `ProductCategoriesRepository.ensureGlobal()` (idempotent
 * find-then-insert keyed on a slug derived from the text).
 */
@Injectable()
export class RealProductsCatalogAdapter implements ProductsCatalogPort {
  private readonly logger = new Logger(RealProductsCatalogAdapter.name);

  constructor(
    private readonly products: ProductsRepository,
    private readonly nutrition: ProductNutritionRepository,
    private readonly categories: ProductCategoriesRepository,
  ) {}

  async upsertGlobal(input: ProductsCatalogUpsertInput): Promise<ProductsCatalogUpsertResult> {
    if (!input.name) {
      // Should already be caught by the service before calling the
      // port (products.name is NOT NULL) — defensive guard so a bad
      // caller gets a clear error instead of a raw DB constraint
      // violation.
      throw new Error('ProductsCatalogPort.upsertGlobal requires a non-empty name');
    }

    const categoryId = input.category
      ? (await this.categories.ensureGlobal({
          slug: slugify(input.category),
          name: input.category,
          sortOrder: 999,
        })).id
      : undefined;

    // `findVisibleByEan(ean, null)` only ever returns a global
    // (tenant_id IS NULL) row or null, so a hit here always means
    // `upsertGlobalByEan` below will take its UPDATE branch.
    const existing = await this.products.findVisibleByEan(input.ean, null);
    const created = !existing;

    const productData: NewProduct = {
      ean: input.ean,
      name: input.name,
      brand: input.brand ?? undefined,
      categoryId,
      // Ingredients live in `description` — the exact field OFF's
      // `ingredients_text` maps to — so community products feed the
      // health/allergen/ingredient-explainer features identically.
      description: input.ingredients ?? undefined,
      imageUrl: input.imageUrl ?? undefined,
      dataSource: input.source,
      isVerified: true,
      status: 'active',
      metadata: input.s3ObjectKeys?.length ? { s3ObjectKeys: input.s3ObjectKeys } : undefined,
    };

    const product = await this.products.upsertGlobalByEan(productData);

    if (input.nutrition) {
      await this.nutrition.upsertForProduct(product.id, {
        ...toDecimalRow(input.nutrition),
        dataSource: input.source,
      });
    }

    this.logger.log(
      `real.products_catalog.upsert ean=${input.ean} productId=${product.id} created=${created} source=${input.source} hasNutrition=${Boolean(input.nutrition)}`,
    );

    return { productId: product.id, created };
  }
}

function toDecimalRow(n: ProductsCatalogNutritionInput) {
  const dec = (v?: number) => (v === undefined ? undefined : v.toString());
  return {
    servingSize: dec(n.servingSize),
    servingUnit: n.servingUnit,
    calories: dec(n.calories),
    protein: dec(n.protein),
    carbohydrates: dec(n.carbohydrates),
    sugars: dec(n.sugars),
    fat: dec(n.fat),
    saturatedFat: dec(n.saturatedFat),
    transFat: dec(n.transFat),
    fiber: dec(n.fiber),
    sodium: dec(n.sodium),
  };
}

/** Slug for `ProductCategoriesRepository.ensureGlobal` — lowercase, hyphenated. */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}
