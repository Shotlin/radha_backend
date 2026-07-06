/**
 * Shared contract for external product-data providers.
 *
 * `ProductLookupService` (BE-10/BE-11) walks providers in priority
 * order on a local DB miss: Open Food Facts (food) stays special-cased
 * exactly as it is today; Open Beauty Facts (cosmetics/personal care),
 * Open Products Facts (household/general merchandise) and UPCitemdb
 * (generic last-resort fallback) implement this interface and are
 * tried via `ProductProviderRegistryService`.
 *
 * Keeping this provider-neutral (own folder, not nested under any one
 * integration) mirrors how `razorpay.types.ts`'s `IRazorpayProvider`
 * lives directly under `razorpay/`, not under a specific provider.
 */

export type ProductProviderName =
  | 'open_food_facts'
  | 'open_beauty_facts'
  | 'open_products_facts'
  | 'upc_item_db';

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

/** Mapped nutrition data ready for `product_nutrition`. Food-only — providers with no nutrition concept (UPCitemdb, generally Beauty/Products) return `null`. */
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

export interface ProductLookupHit {
  mapped: MappedProductData;
  nutrition: MappedNutritionData | null;
}

export interface IProductDataProvider {
  readonly providerName: ProductProviderName;
  lookupByEan(ean: string): Promise<ProductLookupHit | null>;
  isHealthy(): Promise<boolean>;
}
