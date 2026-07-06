import { Injectable } from '@nestjs/common';

import type {
  MappedNutritionData,
  MappedProductData,
} from '@/integrations/products/product-provider.types';

import type { ObfProduct } from './obf.types';

/**
 * Pure transformation layer from OBF responses to RADHA-shaped data.
 *
 * Cosmetics/personal-care products have no nutrition concept — OBF's
 * `nutrition` field (when present) describes packaging input sets, not
 * food nutriments — so `mapToNutrition` always returns `null` rather
 * than force-fitting an unrelated shape. `ScoringEngineService`
 * already handles a missing nutrition row gracefully (grade 'U',
 * status 'data_unavailable'), so this is the correct, honest mapping,
 * not a gap to fix later.
 *
 * No DB access, no I/O — easy to unit-test. Mirrors `OffMapperService`.
 */
@Injectable()
export class ObfMapperService {
  mapToProduct(obf: ObfProduct): MappedProductData {
    return {
      ean: obf.code,
      name: obf.product_name_en ?? obf.product_name ?? `Product ${obf.code}`,
      brand: this.firstBrand(obf.brands),
      manufacturer: obf.manufacturing_places ?? undefined,
      category: this.cleanCategoryTag(obf.categories_tags?.[0]),
      subCategory: this.cleanCategoryTag(obf.categories_tags?.[1]),
      imageUrl: obf.image_front_url ?? obf.image_url,
      packageSize: this.extractQuantity(obf.quantity),
      packageUnit: this.extractQuantityUnit(obf.quantity),
      description: obf.ingredients_text?.slice(0, 1000),
      dataSource: 'open_beauty_facts',
      externalId: obf.code,
    };
  }

  mapToNutrition(_obf: ObfProduct): MappedNutritionData | null {
    return null;
  }

  extractAllergens(obf: ObfProduct): string[] {
    if (!obf.allergens_tags || obf.allergens_tags.length === 0) return [];
    return obf.allergens_tags
      .map((tag) => this.stripLanguagePrefix(tag))
      .filter((s) => s.length > 0);
  }

  confidence(obf: ObfProduct): number {
    const checks: Array<[boolean, number]> = [
      [Boolean(obf.product_name || obf.product_name_en), 0.3],
      [Boolean(obf.brands), 0.2],
      [Boolean(obf.categories_tags?.length), 0.2],
      [Boolean(obf.image_url || obf.image_front_url), 0.15],
      [Boolean(obf.ingredients_text), 0.15],
    ];
    const total = checks.reduce((acc, [, w]) => acc + w, 0);
    const got = checks.reduce((acc, [hit, w]) => acc + (hit ? w : 0), 0);
    return Math.round((got / total) * 100) / 100;
  }

  private firstBrand(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    return raw.split(',')[0]?.trim() || undefined;
  }

  private extractQuantity(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const match = raw.match(/(\d+(?:\.\d+)?)/);
    return match ? match[1] : undefined;
  }

  private extractQuantityUnit(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const match = raw.toLowerCase().match(/(g|kg|ml|l|oz)/);
    return match ? match[1] : undefined;
  }

  private cleanCategoryTag(tag: string | undefined): string | undefined {
    if (!tag) return undefined;
    return this.stripLanguagePrefix(tag)
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private stripLanguagePrefix(tag: string): string {
    return tag.replace(/^[a-z]{2,3}:/, '');
  }
}
