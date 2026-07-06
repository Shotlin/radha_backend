import { Injectable } from '@nestjs/common';

import type { MappedNutritionData, MappedProductData, OffProduct } from './off.types';

/**
 * Pure transformation layer from OFF responses to RADHA-shaped data.
 *
 * Two outputs:
 *   - `mapToProduct(off)` returns a `MappedProductData` ready to insert
 *     into the `products` table.
 *   - `mapToNutrition(off)` returns a `MappedNutritionData` ready for
 *     `product_nutrition`, or `null` if OFF has no usable nutriments.
 *
 * No DB access, no I/O — easy to unit-test.
 */
@Injectable()
export class OffMapperService {
  mapToProduct(off: OffProduct): MappedProductData {
    return {
      ean: off.code,
      name: off.product_name_en ?? off.product_name ?? `Product ${off.code}`,
      brand: this.firstBrand(off.brands),
      manufacturer: off.manufacturing_places ?? undefined,
      category: this.cleanCategoryTag(off.categories_tags?.[0]),
      subCategory: this.cleanCategoryTag(off.categories_tags?.[1]),
      imageUrl: off.image_front_url ?? off.image_url,
      packageSize: this.extractQuantity(off.quantity),
      packageUnit: this.extractQuantityUnit(off.quantity),
      description: off.ingredients_text?.slice(0, 1000),
      dataSource: 'open_food_facts',
      externalId: off.code,
    };
  }

  mapToNutrition(off: OffProduct): MappedNutritionData | null {
    const n = off.nutriments;
    if (!n) return null;
    const hasAny =
      n.energy_kcal_100g !== undefined ||
      n.proteins_100g !== undefined ||
      n.carbohydrates_100g !== undefined ||
      n.fat_100g !== undefined;
    if (!hasAny) return null;
    return {
      servingSize: 100,
      servingUnit: 'g',
      calories: n.energy_kcal_100g,
      protein: n.proteins_100g,
      carbohydrates: n.carbohydrates_100g,
      sugars: n.sugars_100g,
      fat: n.fat_100g,
      saturatedFat: n['saturated-fat_100g'],
      transFat: n['trans-fat_100g'],
      fiber: n.fiber_100g,
      sodium: this.gToMg(n.sodium_100g) ?? this.gToMg(this.saltToSodium(n.salt_100g)),
      containsAllergens: this.extractAllergens(off),
      isProcessed: this.detectProcessingLevel(off),
      dataSource: 'open_food_facts',
      confidence: this.confidence(off),
    };
  }

  detectProcessingLevel(off: OffProduct): 'not' | 'lightly' | 'ultra' {
    if (off.nova_group === 1 || off.nova_group === 2) return 'not';
    if (off.nova_group === 3) return 'lightly';
    if (off.nova_group === 4) return 'ultra';
    // Heuristic when NOVA missing
    const len = off.ingredients_text?.length ?? 0;
    if (len > 500) return 'ultra';
    if (len > 200) return 'lightly';
    return 'not';
  }

  extractAllergens(off: OffProduct): string[] {
    if (!off.allergens_tags || off.allergens_tags.length === 0) return [];
    return off.allergens_tags
      .map((tag) => this.stripLanguagePrefix(tag))
      .filter((s) => s.length > 0);
  }

  confidence(off: OffProduct): number {
    const checks: Array<[boolean, number]> = [
      [Boolean(off.product_name || off.product_name_en), 0.2],
      [Boolean(off.brands), 0.1],
      [Boolean(off.categories_tags?.length), 0.15],
      [Boolean(off.image_url || off.image_front_url), 0.1],
      [Boolean(off.nutriments?.energy_kcal_100g), 0.2],
      [Boolean(off.ingredients_text), 0.15],
      [Boolean(off.nova_group), 0.1],
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

  private gToMg(grams: number | undefined): number | undefined {
    if (grams === undefined) return undefined;
    return grams * 1_000;
  }

  private saltToSodium(saltGrams: number | undefined): number | undefined {
    // Salt → sodium uses molar-mass ratio (Na is ~39.34% of NaCl).
    if (saltGrams === undefined) return undefined;
    return saltGrams * 0.3934;
  }
}
