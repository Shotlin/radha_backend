import { Injectable, Optional } from '@nestjs/common';

import { ValidationException } from '@/common/errors/business.exception';
import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import { OffMapperService } from '@/integrations/open-food-facts/off-mapper.service';
import { OpenFoodFactsService } from '@/integrations/open-food-facts/off.service';
import type {
  ProductLookupHit,
  ProductProviderName,
} from '@/integrations/products/product-provider.types';

import type { ProductRow, ProductNutritionRow } from '@/db/schema/products';
import { products as productsTable, productNutrition } from '@/db/schema/products';

import { ProductNutritionRepository } from '../repositories/product-nutrition.repository';
import { ProductsRepository } from '../products.repository';
import { normaliseEan, validateEan } from '../utils/ean.utils';

import { ProductProviderRegistryService } from './product-provider-registry.service';

export interface LookupOptions {
  includeNutrition?: boolean;
  forceRefresh?: boolean;
  fallbackToExternal?: boolean;
}

export interface ProductWithDetails extends ProductRow {
  nutrition?: ProductNutritionRow | null;
}

export interface ProductLookupResult {
  found: boolean;
  product?: ProductWithDetails;
  source:
    | 'database'
    | 'open-food-facts'
    | 'open-beauty-facts'
    | 'open-products-facts'
    | 'upc-item-db'
    | 'manual'
    | 'cached'
    | 'unknown';
  cached: boolean;
  externalApiCalled: boolean;
  durationMs: number;
}

/**
 * BE-10 + BE-11 lookup orchestrator.
 *
 * Order of attempts:
 *   1. Tenant-private + global products in `products` (BE-10).
 *   2. If `fallbackToExternal !== false`, hit OFF (BE-11) and on
 *      success persist a global-catalog row (`tenant_id = NULL`,
 *      `dataSource = 'open_food_facts'`) plus a `product_nutrition`
 *      row mapped from OFF nutriments. Subsequent lookups for the
 *      same EAN will short-circuit at step 1.
 *   3. If OFF didn't find it either, walk the additional provider
 *      chain (Open Beauty Facts -> Open Products Facts -> UPCitemdb)
 *      via `ProductProviderRegistryService` and persist the first hit
 *      the same way. This step is purely additive: OFF's own path
 *      above is untouched, and this only runs when OFF already missed.
 *
 * The OFF dependency (and the registry) is `@Optional()` so unit
 * tests don't need to stand up the entire integration stack.
 */
@Injectable()
export class ProductLookupService {
  constructor(
    private readonly products: ProductsRepository,
    private readonly nutrition: ProductNutritionRepository,
    private readonly logger: LoggerService,
    private readonly db: DbService,
    @Optional() private readonly off?: OpenFoodFactsService,
    @Optional() private readonly mapper?: OffMapperService,
    @Optional() private readonly registry?: ProductProviderRegistryService,
  ) {}

  private resolveSource(dataSource: string): ProductLookupResult['source'] {
    switch (dataSource) {
      case 'open_food_facts':
        return 'open-food-facts';
      case 'open_beauty_facts':
        return 'open-beauty-facts';
      case 'open_products_facts':
        return 'open-products-facts';
      case 'upc_item_db':
        return 'upc-item-db';
      default:
        return 'database';
    }
  }

  async lookupByEan(
    rawEan: string,
    tenantId: string | null,
    options: LookupOptions = {},
  ): Promise<ProductLookupResult> {
    const start = Date.now();
    const validation = validateEan(rawEan);
    if (!validation.valid) {
      throw new ValidationException(validation.error ?? 'Invalid EAN', {
        field: 'ean',
        value: rawEan,
      });
    }
    const ean = normaliseEan(rawEan);

    const local = await this.products.findVisibleByEan(ean, tenantId);
    if (local && !options.forceRefresh) {
      const enriched = await this.enrich(local, options);
      return {
        found: true,
        product: enriched,
        source: this.resolveSource(local.dataSource),
        cached: false,
        externalApiCalled: false,
        durationMs: Date.now() - start,
      };
    }

    if (options.fallbackToExternal !== false && this.off && this.mapper) {
      const off = await this.off.lookupByEan(ean);
      if (off) {
        const upserted = await this.persistFromOff(ean, off);
        const enriched = await this.enrich(upserted, options);
        return {
          found: true,
          product: enriched,
          source: 'open-food-facts',
          cached: false,
          externalApiCalled: true,
          durationMs: Date.now() - start,
        };
      }
    } else {
      this.logger.debug('product.lookup.external_skipped', { ean });
    }

    if (options.fallbackToExternal !== false && this.registry) {
      const result = await this.registry.tryAll(ean);
      if (result) {
        const upserted = await this.persistFromProvider(
          ean,
          result.provider.providerName,
          result.hit,
        );
        const enriched = await this.enrich(upserted, options);
        return {
          found: true,
          product: enriched,
          source: this.resolveSource(result.provider.providerName),
          cached: false,
          externalApiCalled: true,
          durationMs: Date.now() - start,
        };
      }
    }

    return {
      found: false,
      source: 'unknown',
      cached: false,
      externalApiCalled: this.off !== undefined || this.registry !== undefined,
      durationMs: Date.now() - start,
    };
  }

  async lookupBatch(
    rawEans: string[],
    tenantId: string | null,
  ): Promise<Map<string, ProductLookupResult>> {
    const out = new Map<string, ProductLookupResult>();
    if (rawEans.length === 0) return out;

    const normalised = rawEans.map((e) => {
      const v = validateEan(e);
      return { raw: e, valid: v.valid, ean: v.normalised ?? normaliseEan(e) };
    });
    const validList = normalised.filter((n) => n.valid);
    const products = await this.products.findManyByEans(
      validList.map((v) => v.ean),
      tenantId,
    );
    const byEan = new Map<string, ProductRow>();
    for (const p of products) {
      const existing = byEan.get(p.ean);
      if (!existing || (existing.tenantId === null && p.tenantId !== null)) {
        byEan.set(p.ean, p);
      }
    }
    for (const item of normalised) {
      if (!item.valid) {
        out.set(item.raw, this.miss());
        continue;
      }
      const product = byEan.get(item.ean);
      if (!product) {
        out.set(item.raw, this.miss());
        continue;
      }
      const enriched = await this.enrich(product, {});
      out.set(item.raw, {
        found: true,
        product: enriched,
        source: this.resolveSource(product.dataSource),
        cached: false,
        externalApiCalled: false,
        durationMs: 0,
      });
    }
    return out;
  }

  private async enrich(product: ProductRow, options: LookupOptions): Promise<ProductWithDetails> {
    if (options.includeNutrition === false) return product;
    const nutrition = await this.nutrition.findByProductId(product.id);
    return { ...product, nutrition };
  }

  private miss(): ProductLookupResult {
    return {
      found: false,
      source: 'unknown',
      cached: false,
      externalApiCalled: false,
      durationMs: 0,
    };
  }

  private async persistFromOff(
    ean: string,
    off: NonNullable<Awaited<ReturnType<OpenFoodFactsService['lookupByEan']>>>,
  ): Promise<ProductRow> {
    if (!this.mapper) {
      throw new Error('OffMapperService not available');
    }
    const productData = this.mapper.mapToProduct(off);
    const nutritionData = this.mapper.mapToNutrition(off);

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(productsTable)
        .values({
          tenantId: null, // global catalog
          ean,
          name: productData.name,
          brand: productData.brand,
          manufacturer: productData.manufacturer,
          subCategory: productData.subCategory,
          imageUrl: productData.imageUrl,
          description: productData.description,
          packageSize: productData.packageSize,
          packageUnit: productData.packageUnit,
          status: 'active',
          dataSource: 'open_food_facts',
          externalId: productData.externalId,
        })
        // No explicit target: this drizzle-orm version emits the `where`
        // option *after* `DO NOTHING` (`(ean) do nothing where ...`), which
        // is invalid Postgres syntax for a partial-index conflict target
        // (the predicate must precede `DO NOTHING`). Omitting the target
        // entirely yields a plain `ON CONFLICT DO NOTHING`, which matches
        // *any* unique violation — including the partial unique index
        // `products_global_ean_unique` (migration 0031) — without needing
        // index inference at all.
        .onConflictDoNothing()
        .returning();

      const product =
        row ??
        (await this.products.findVisibleByEan(ean, null)) ??
        (() => {
          throw new Error(`Failed to persist OFF product for ${ean}`);
        })();

      if (nutritionData && product) {
        await tx
          .insert(productNutrition)
          .values({
            productId: product.id,
            servingSize: this.toDecimal(nutritionData.servingSize),
            servingUnit: nutritionData.servingUnit,
            calories: this.toDecimal(nutritionData.calories),
            protein: this.toDecimal(nutritionData.protein),
            carbohydrates: this.toDecimal(nutritionData.carbohydrates),
            sugars: this.toDecimal(nutritionData.sugars),
            fat: this.toDecimal(nutritionData.fat),
            saturatedFat: this.toDecimal(nutritionData.saturatedFat),
            transFat: this.toDecimal(nutritionData.transFat),
            fiber: this.toDecimal(nutritionData.fiber),
            sodium: this.toDecimal(nutritionData.sodium),
            containsAllergens: nutritionData.containsAllergens,
            isProcessed: nutritionData.isProcessed,
            dataSource: 'open_food_facts',
            confidence: this.toDecimal(nutritionData.confidence),
          })
          .onConflictDoNothing({ target: productNutrition.productId });
      }
      return product as ProductRow;
    });
  }

  /**
   * Sibling to `persistFromOff` for the additional providers
   * (Open Beauty Facts / Open Products Facts / UPCitemdb). Takes
   * already-mapped data (those providers map internally before
   * returning a `ProductLookupHit`, unlike OFF's raw-then-mapped
   * split) and persists it identically — same global-catalog
   * (`tenant_id = NULL`) + idempotent-by-EAN insert pattern,
   * including the no-explicit-target `onConflictDoNothing()` on the
   * products insert (see the comment in `persistFromOff` — same
   * drizzle-orm partial-index quirk applies here). `persistFromOff`
   * itself is untouched.
   */
  private async persistFromProvider(
    ean: string,
    providerName: ProductProviderName,
    hit: ProductLookupHit,
  ): Promise<ProductRow> {
    const { mapped, nutrition: nutritionData } = hit;

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(productsTable)
        .values({
          tenantId: null, // global catalog
          ean,
          name: mapped.name,
          brand: mapped.brand,
          manufacturer: mapped.manufacturer,
          subCategory: mapped.subCategory,
          imageUrl: mapped.imageUrl,
          description: mapped.description,
          packageSize: mapped.packageSize,
          packageUnit: mapped.packageUnit,
          status: 'active',
          dataSource: providerName,
          externalId: mapped.externalId,
        })
        .onConflictDoNothing()
        .returning();

      const product =
        row ??
        (await this.products.findVisibleByEan(ean, null)) ??
        (() => {
          throw new Error(`Failed to persist ${providerName} product for ${ean}`);
        })();

      if (nutritionData && product) {
        await tx
          .insert(productNutrition)
          .values({
            productId: product.id,
            servingSize: this.toDecimal(nutritionData.servingSize),
            servingUnit: nutritionData.servingUnit,
            calories: this.toDecimal(nutritionData.calories),
            protein: this.toDecimal(nutritionData.protein),
            carbohydrates: this.toDecimal(nutritionData.carbohydrates),
            sugars: this.toDecimal(nutritionData.sugars),
            fat: this.toDecimal(nutritionData.fat),
            saturatedFat: this.toDecimal(nutritionData.saturatedFat),
            transFat: this.toDecimal(nutritionData.transFat),
            fiber: this.toDecimal(nutritionData.fiber),
            sodium: this.toDecimal(nutritionData.sodium),
            containsAllergens: nutritionData.containsAllergens,
            isProcessed: nutritionData.isProcessed,
            dataSource: providerName,
            confidence: this.toDecimal(nutritionData.confidence),
          })
          .onConflictDoNothing({ target: productNutrition.productId });
      }
      return product as ProductRow;
    });
  }

  private toDecimal(n: number | undefined): string | undefined {
    return n === undefined ? undefined : String(n);
  }
}
