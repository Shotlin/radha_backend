/**
 * Open Beauty Facts API types.
 *
 * Same envelope as Open Food Facts (`{status, status_verbose, product}`)
 * — only the fields RADHA actually consumes are typed; cosmetics
 * products rarely carry `nutriments`, ingredient/allergen data matters
 * more here than nutrition.
 */

export interface ObfProduct {
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
  quantity?: string;
  manufacturing_places?: string;
  countries_tags?: string[];
}

export interface ObfApiResponse {
  status: 0 | 1;
  status_verbose?: string;
  product?: ObfProduct;
}

export interface ObfStats {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  apiSuccess: number;
  apiFailures: number;
  circuitState: 'closed' | 'open' | 'half-open';
  averageResponseMs: number;
}
