/**
 * Open Food Facts API types.
 *
 * Only the fields RADHA actually consumes are typed; the OFF schema
 * has hundreds of optional keys and trying to mirror the full surface
 * is a maintenance nightmare. Anything we don't list lives in the
 * raw JSONB cache row and is ignored by the mapper.
 */

import type { ProductProviderName } from '@/integrations/products/product-provider.types';

export interface OffNutriments {
  energy_100g?: number;
  energy_kcal_100g?: number;
  proteins_100g?: number;
  carbohydrates_100g?: number;
  sugars_100g?: number;
  fat_100g?: number;
  'saturated-fat_100g'?: number;
  'trans-fat_100g'?: number;
  fiber_100g?: number;
  salt_100g?: number;
  sodium_100g?: number;
}

export interface OffProduct {
  code: string;
  product_name?: string;
  product_name_en?: string;
  brands?: string;
  categories?: string;
  categories_tags?: string[];
  image_url?: string;
  image_front_url?: string;
  image_small_url?: string;
  ingredients_text?: string;
  ingredients_tags?: string[];
  allergens?: string;
  allergens_tags?: string[];
  nova_group?: number;
  nutrition_grades?: string;
  ecoscore_grade?: string;
  packaging?: string;
  quantity?: string;
  serving_size?: string;
  nutriments?: OffNutriments;
  countries_tags?: string[];
  manufacturing_places?: string;
  origins?: string;
}

export interface OffApiResponse {
  status: 0 | 1;
  status_verbose?: string;
  product?: OffProduct;
}

/**
 * Response shape from the OFF category/search endpoint
 * (`/cgi/search.pl?json=1`). Only the paging envelope + product list is typed;
 * each entry is a partial {@link OffProduct} limited to `OFF_SEARCH_FIELDS`.
 */
export interface OffSearchResponse {
  count?: number;
  page?: number;
  page_size?: number;
  products?: OffProduct[];
}

/** Mapped product data ready to insert into `products`. */
export interface MappedProductData {
  ean: string;
  name: string;
  brand?: string;
  manufacturer?: string;
  category?: string;
  subCategory?: string;
  imageUrl?: string;
  packageSize?: string;
  packageUnit?: string;
  description?: string;
  dataSource: ProductProviderName;
  externalId: string;
}

/** Mapped nutrition data ready for `product_nutrition`. */
export interface MappedNutritionData {
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
  containsAllergens: string[];
  isProcessed: 'not' | 'lightly' | 'ultra';
  dataSource: ProductProviderName;
  confidence: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface OffStats {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  apiSuccess: number;
  apiFailures: number;
  circuitState: CircuitState;
  averageResponseMs: number;
}
