import { Injectable } from '@nestjs/common';

import type {
  MappedNutritionData,
  MappedProductData,
} from '@/integrations/products/product-provider.types';

import type { UpcItem } from './upc.types';

/**
 * Pure transformation layer from UPCitemdb responses to RADHA-shaped
 * data. No nutrition concept at all (generic merchandise database) —
 * `mapToNutrition` always returns `null`, same rationale as the Open
 * Beauty/Products Facts mappers.
 */
@Injectable()
export class UpcMapperService {
  mapToProduct(item: UpcItem, ean: string): MappedProductData {
    const categoryParts = (item.category ?? '')
      .split('>')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return {
      ean,
      name: item.title?.trim() || `Product ${ean}`,
      brand: item.brand?.trim() || undefined,
      category: categoryParts[0],
      subCategory: categoryParts[1],
      imageUrl: item.images?.[0],
      description: item.description?.slice(0, 1000),
      dataSource: 'upc_item_db',
      externalId: item.upc ?? item.ean ?? ean,
    };
  }

  mapToNutrition(_item: UpcItem): MappedNutritionData | null {
    return null;
  }
}
