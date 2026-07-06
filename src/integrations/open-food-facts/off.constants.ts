/**
 * Open Food Facts (OFF) integration constants.
 *
 * OFF is a free, community-maintained product database. We hit the
 * v2 product endpoint, identify ourselves with a descriptive
 * `User-Agent`, and cache aggressively.
 */

export const OFF_BASE_URL = 'https://world.openfoodfacts.org' as const;
export const OFF_API_VERSION = 'v2' as const;
export const OFF_USER_AGENT = 'RADHA-Backend/1.0 (https://radha.app; contact@radha.app)' as const;

/** Default cache lifetime — 30 days. OFF data changes slowly. */
export const OFF_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Wall-clock timeout per HTTP request. */
export const OFF_REQUEST_TIMEOUT_MS = 5_000;

/** Number of consecutive failures before the circuit breaker trips. */
export const OFF_CB_FAILURE_THRESHOLD = 5;

/** Successes needed in `half-open` state before transitioning to `closed`. */
export const OFF_CB_SUCCESS_THRESHOLD = 2;

/** Time the circuit stays `open` before allowing a probe request. */
export const OFF_CB_OPEN_DURATION_MS = 60_000;

/**
 * Field projection for the OFF category-search endpoint. Restricting to the
 * fields the mapper actually consumes keeps each search page small (OFF rows
 * carry hundreds of keys) so the bulk catalog import stays fast and within the
 * request timeout.
 */
export const OFF_SEARCH_FIELDS: string =
  'code,product_name,product_name_en,brands,categories,categories_tags,' +
  'image_url,image_front_url,image_small_url,ingredients_text,allergens,' +
  'allergens_tags,nova_group,nutrition_grades,quantity,nutriments,' +
  'countries_tags,manufacturing_places';

/** Hard cap on OFF search page size (the API itself rejects larger pages). */
export const OFF_SEARCH_MAX_PAGE_SIZE = 100;
