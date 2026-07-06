import { Injectable } from '@nestjs/common';

import type {
  MappedNutritionData,
  MappedProductData,
} from '@/integrations/products/product-provider.types';

import type { OpfProduct } from './opf.types';

/**
 * Pure transformation layer from OPF responses to RADHA-shaped data.
 * General/household merchandise has no nutrition concept, so
 * `mapToNutrition` always returns `null` — `ScoringEngineService`
 * already handles a missing nutrition row gracefully. Mirrors
 * `OffMapperService` / `ObfMapperService`.
 */
@Injectable()
export class OpfMapperService {
  mapToProduct(opf: OpfProduct): MappedProductData {
    return {
      ean: opf.code,
      name: opf.product_name_en ?? opf.product_name ?? `Product ${opf.code}`,
      brand: this.firstBrand(opf.brands),
      manufacturer: opf.manufacturing_places ?? undefined,
      category: this.cleanCategoryTag(opf.categories_tags?.[0]),
      subCategory: this.cleanCategoryTag(opf.categories_tags?.[1]),
      imageUrl: opf.image_front_url ?? opf.image_url,
      packageSize: this.extractQuantity(opf.quantity),
      packageUnit: this.extractQuantityUnit(opf.quantity),
      description: opf.ingredients_text?.slice(0, 1000),
      dataSource: 'open_products_facts',
      externalId: opf.code,
    };
  }

  mapToNutrition(_opf: OpfProduct): MappedNutritionData | null {
    return null;
  }

  confidence(opf: OpfProduct): number {
    const checks: Array<[boolean, number]> = [
      [Boolean(opf.product_name || opf.product_name_en), 0.3],
      [Boolean(opf.brands), 0.2],
      [Boolean(opf.categories_tags?.length), 0.2],
      [Boolean(opf.image_url || opf.image_front_url), 0.15],
      [Boolean(opf.ingredients_text), 0.15],
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
