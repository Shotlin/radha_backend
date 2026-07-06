import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import type { NewProductNutrition } from '@/db/schema/products';
import { OffMapperService } from '@/integrations/open-food-facts/off-mapper.service';
import { OpenFoodFactsService } from '@/integrations/open-food-facts/off.service';
import type { MappedNutritionData, OffProduct } from '@/integrations/open-food-facts/off.types';
import { HealthScoringService } from '@/modules/health-scoring/services/health-scoring.service';
import { ProductCategoriesRepository } from '@/modules/products/repositories/product-categories.repository';
import { ProductNutritionRepository } from '@/modules/products/repositories/product-nutrition.repository';
import { ProductsRepository } from '@/modules/products/products.repository';

import { CATALOG_CATEGORIES } from './catalog-import.constants';
import {
  CURATED_CATALOG,
  curatedSearchQuery,
  type CuratedProductSeed,
} from './curated-catalog.constants';

export interface CatalogImportOptions {
  /** OFF pages to pull per category tag (default 3). */
  pagesPerCategory?: number;
  /** Products per OFF page (default 50, capped at 100 by the OFF client). */
  pageSize?: number;
  /** OFF country scope (default 'india'). */
  country?: string;
}

export interface CatalogImportSummary {
  categoriesEnsured: number;
  productsUpserted: number;
  nutritionUpserted: number;
  scored: number;
  skipped: number;
  errors: number;
}

export interface CuratedImportOptions {
  /** OFF country scope for text resolution (default 'india'). */
  country?: string;
  /**
   * Minimum match confidence (0..1) for accepting an OFF candidate as the real
   * barcode for a curated product. Below this, the product is skipped (never
   * seeded with a guessed code). Default 0.45.
   */
  minConfidence?: number;
}

export interface CuratedImportItemResult {
  slug: string;
  /** The real EAN resolved from OFF, or null when unresolved (then skipped). */
  resolvedEan: string | null;
  status: 'seeded' | 'unresolved' | 'low_confidence' | 'error';
}

export interface CuratedImportSummary {
  categoriesEnsured: number;
  productsUpserted: number;
  nutritionUpserted: number;
  scored: number;
  /** Products OFF could not confidently resolve a real barcode for. */
  unresolved: number;
  /** Resolved rows whose OFF barcode was not a valid retail EAN. */
  skipped: number;
  errors: number;
  /** Per-product outcome — feeds the EAN write-back into the mobile manifest. */
  items: CuratedImportItemResult[];
}

/** The mutable counters {@link CatalogImportService.importOne} increments. */
interface ProductImportCounters {
  productsUpserted: number;
  nutritionUpserted: number;
  scored: number;
  skipped: number;
}

/**
 * Bulk-imports the consumer browse catalog from Open Food Facts.
 *
 * For each food category it pages through OFF, maps each product into the
 * **global catalog** (tenant_id = NULL), upserts nutrition, then runs the
 * deterministic health scorer so the browse list can show + sort by rating.
 *
 * Robustness: every product is imported in its own try/catch — a single bad OFF
 * row never aborts the run. The whole thing is idempotent (upsert by EAN), so
 * re-running refreshes data without creating duplicates.
 *
 * Lives in its own module to keep the Products ⇄ HealthScoring circular pair
 * out of the dependency graph (this module depends on both, neither depends on
 * it). Invoked by the `db:import:catalog` CLI; never wired to a request path.
 */
@Injectable()
export class CatalogImportService {
  constructor(
    private readonly off: OpenFoodFactsService,
    private readonly mapper: OffMapperService,
    private readonly products: ProductsRepository,
    private readonly nutrition: ProductNutritionRepository,
    private readonly categories: ProductCategoriesRepository,
    private readonly scoring: HealthScoringService,
    private readonly logger: LoggerService,
  ) {}

  async run(options: CatalogImportOptions = {}): Promise<CatalogImportSummary> {
    const pages = Math.max(1, options.pagesPerCategory ?? 3);
    const pageSize = options.pageSize ?? 50;
    const country = options.country ?? 'india';

    const summary: CatalogImportSummary = {
      categoriesEnsured: 0,
      productsUpserted: 0,
      nutritionUpserted: 0,
      scored: 0,
      skipped: 0,
      errors: 0,
    };

    for (const cfg of CATALOG_CATEGORIES) {
      const category = await this.categories.ensureGlobal({
        slug: cfg.slug,
        name: cfg.name,
        sortOrder: cfg.sortOrder,
      });
      summary.categoriesEnsured += 1;

      if (cfg.offCategoryTags.length === 0) {
        this.logger.info('catalog.import.skip_non_food', { slug: cfg.slug });
        continue;
      }

      for (const tag of cfg.offCategoryTags) {
        for (let page = 1; page <= pages; page += 1) {
          const offProducts = await this.off.searchByCategory(tag, { page, pageSize, country });
          if (offProducts.length === 0) break; // no more pages for this tag

          for (const off of offProducts) {
            try {
              await this.importOne(off, category.id, summary);
            } catch (err) {
              summary.errors += 1;
              this.logger.warn('catalog.import.product_failed', {
                ean: off.code,
                tag,
                error: { name: (err as Error).name, message: (err as Error).message },
              });
            }
          }
        }
      }

      this.logger.info('catalog.import.category_done', {
        slug: cfg.slug,
        productsUpserted: summary.productsUpserted,
      });
    }

    this.logger.info('catalog.import.complete', { ...summary });
    return summary;
  }

  /**
   * Seeds the **curated launch catalog** — the 29 hand-picked Indian retail
   * products that mirror the mobile `launch_catalog.dart` spine — by resolving
   * each product's *real* market barcode from Open Food Facts text-search.
   *
   * Honesty contract: no barcode is ever fabricated. For each curated product
   * we query OFF by brand+name, pick the best candidate that clears a country
   * + name-match + confidence bar, and seed it through the same upsert →
   * nutrition → score pipeline as the bulk import. Products OFF cannot
   * confidently resolve are reported `unresolved` and left absent (the mobile
   * detail screen degrades to an honest "scan to unlock" state).
   *
   * Idempotent: products upsert by EAN, categories ensure-by-slug. The returned
   * per-item results carry the resolved EAN so the caller can write them back
   * into the mobile manifest.
   */
  async importCurated(options: CuratedImportOptions = {}): Promise<CuratedImportSummary> {
    const country = options.country ?? 'india';
    const minConfidence = options.minConfidence ?? 0.45;

    const summary: CuratedImportSummary = {
      categoriesEnsured: 0,
      productsUpserted: 0,
      nutritionUpserted: 0,
      scored: 0,
      unresolved: 0,
      skipped: 0,
      errors: 0,
      items: [],
    };

    // Ensure every category slug used by the curated set exists, once.
    const categoryIdBySlug = new Map<string, string>();
    for (const cfg of CATALOG_CATEGORIES) {
      const category = await this.categories.ensureGlobal({
        slug: cfg.slug,
        name: cfg.name,
        sortOrder: cfg.sortOrder,
      });
      categoryIdBySlug.set(cfg.slug, category.id);
      summary.categoriesEnsured += 1;
    }

    for (const seed of CURATED_CATALOG) {
      const categoryId = categoryIdBySlug.get(seed.categorySlug);
      if (!categoryId) {
        summary.errors += 1;
        summary.items.push({ slug: seed.slug, resolvedEan: null, status: 'error' });
        this.logger.warn('catalog.curated.unknown_category', {
          slug: seed.slug,
          categorySlug: seed.categorySlug,
        });
        continue;
      }

      try {
        const match = await this.resolveCurated(seed, country, minConfidence);
        if (!match) {
          summary.unresolved += 1;
          summary.items.push({ slug: seed.slug, resolvedEan: null, status: 'unresolved' });
          this.logger.info('catalog.curated.unresolved', {
            slug: seed.slug,
            query: curatedSearchQuery(seed),
          });
          continue;
        }

        await this.importOne(match.off, categoryId, summary);
        summary.items.push({ slug: seed.slug, resolvedEan: match.off.code, status: 'seeded' });
        this.logger.info('catalog.curated.seeded', {
          slug: seed.slug,
          ean: match.off.code,
          confidence: match.confidence,
        });
      } catch (err) {
        summary.errors += 1;
        summary.items.push({ slug: seed.slug, resolvedEan: null, status: 'error' });
        this.logger.warn('catalog.curated.failed', {
          slug: seed.slug,
          error: { name: (err as Error).name, message: (err as Error).message },
        });
      }
    }

    this.logger.info('catalog.curated.complete', {
      categoriesEnsured: summary.categoriesEnsured,
      productsUpserted: summary.productsUpserted,
      nutritionUpserted: summary.nutritionUpserted,
      scored: summary.scored,
      unresolved: summary.unresolved,
      errors: summary.errors,
    });
    return summary;
  }

  /**
   * Resolve a curated seed to a real OFF product by free-text search, scoring
   * each candidate on name overlap + OFF data completeness. Returns the best
   * candidate that has a valid retail barcode and clears `minConfidence`, or
   * `null` (never a guessed barcode).
   */
  private async resolveCurated(
    seed: CuratedProductSeed,
    country: string,
    minConfidence: number,
  ): Promise<{ off: OffProduct; confidence: number } | null> {
    const query = curatedSearchQuery(seed);
    const candidates = await this.off.searchByText(query, { pageSize: 20, country });
    if (candidates.length === 0) return null;

    const wanted = this.tokenize(`${seed.brand ?? ''} ${seed.name}`);
    let best: { off: OffProduct; confidence: number } | null = null;

    for (const off of candidates) {
      const ean = off.code?.trim();
      if (!ean || ean.length < 6 || ean.length > 13) continue; // must be a real retail barcode

      const label = `${off.brands ?? ''} ${off.product_name_en ?? off.product_name ?? ''}`;
      const nameScore = this.tokenOverlap(wanted, this.tokenize(label));
      // Blend name-match (weighted) with OFF's own data-completeness confidence.
      const dataScore = this.mapper.confidence(off);
      const confidence = Math.round((nameScore * 0.7 + dataScore * 0.3) * 100) / 100;

      if (confidence >= minConfidence && (!best || confidence > best.confidence)) {
        best = { off, confidence };
      }
    }

    return best;
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1),
    );
  }

  /** Fraction of the wanted tokens present in the candidate label (0..1). */
  private tokenOverlap(wanted: Set<string>, candidate: Set<string>): number {
    if (wanted.size === 0) return 0;
    let hits = 0;
    for (const token of wanted) {
      if (candidate.has(token)) hits += 1;
    }
    return hits / wanted.size;
  }

  private async importOne(
    off: OffProduct,
    categoryId: string,
    summary: ProductImportCounters,
  ): Promise<void> {
    const mapped = this.mapper.mapToProduct(off);
    const ean = mapped.ean?.trim();

    // The `products.ean` column is varchar(13); OFF occasionally returns longer
    // internal codes. Skip anything that wouldn't be a valid retail barcode.
    if (!ean || ean.length < 6 || ean.length > 13) {
      summary.skipped += 1;
      return;
    }

    const product = await this.products.upsertGlobalByEan({
      tenantId: null,
      ean,
      name: mapped.name,
      brand: mapped.brand,
      manufacturer: mapped.manufacturer,
      categoryId,
      subCategory: mapped.subCategory,
      imageUrl: mapped.imageUrl,
      description: mapped.description,
      packageSize: mapped.packageSize,
      packageUnit: mapped.packageUnit,
      status: 'active',
      dataSource: 'open_food_facts',
      externalId: mapped.externalId,
      metadata: {
        ingredients_text: off.ingredients_text,
        nova_group: off.nova_group,
        nutrition_grades: off.nutrition_grades,
      },
    });
    summary.productsUpserted += 1;

    const mappedNutrition = this.mapper.mapToNutrition(off);
    if (mappedNutrition) {
      await this.nutrition.upsertForProduct(product.id, this.toNutritionRow(mappedNutrition));
      summary.nutritionUpserted += 1;
    }

    try {
      await this.scoring.scoreProduct(product.id, { forceRecompute: true });
      summary.scored += 1;
    } catch (err) {
      this.logger.warn('catalog.import.score_failed', {
        productId: product.id,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
    }
  }

  /** Map OFF numeric nutrition into the decimal-as-string row shape. */
  private toNutritionRow(input: MappedNutritionData): Partial<NewProductNutrition> {
    const dec = (n: number | undefined): string | undefined =>
      n === undefined ? undefined : n.toString();
    return {
      servingSize: dec(input.servingSize),
      servingUnit: input.servingUnit,
      calories: dec(input.calories),
      protein: dec(input.protein),
      carbohydrates: dec(input.carbohydrates),
      sugars: dec(input.sugars),
      fat: dec(input.fat),
      saturatedFat: dec(input.saturatedFat),
      transFat: dec(input.transFat),
      fiber: dec(input.fiber),
      sodium: dec(input.sodium),
      containsAllergens: input.containsAllergens,
      isProcessed: input.isProcessed,
      dataSource: 'open_food_facts',
      confidence: dec(input.confidence),
    };
  }
}
