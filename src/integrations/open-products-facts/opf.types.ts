/**
 * Open Products Facts API types.
 *
 * Same envelope as Open Food Facts (`{status, status_verbose, product}`)
 * — general/household merchandise, no nutrition concept.
 */

export interface OpfProduct {
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
  manufacturing_places?: string;
  quantity?: string;
  countries_tags?: string[];
}

export interface OpfApiResponse {
  status: 0 | 1;
  status_verbose?: string;
  product?: OpfProduct;
}

export interface OpfStats {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  apiSuccess: number;
  apiFailures: number;
  circuitState: 'closed' | 'open' | 'half-open';
  averageResponseMs: number;
}
