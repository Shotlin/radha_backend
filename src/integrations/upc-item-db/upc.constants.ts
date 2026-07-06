/**
 * UPCitemdb integration constants.
 *
 * Generic global barcode database — no nutrition, just name/brand/
 * image. Free "trial" tier needs no signup/API key, but is capped at
 * 100 *combined* requests/day across every RADHA user. Used only as
 * the last-resort fallback after Open Food/Beauty/Products Facts all
 * miss — see `ProductProviderRegistryService`.
 */

export const UPC_BASE_URL = 'https://api.upcitemdb.com/prod/trial' as const;
export const UPC_USER_AGENT = 'RADHA-Backend/1.0 (https://radha.app; contact@radha.app)' as const;

/** Wall-clock timeout per HTTP request. */
export const UPC_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Hard daily cap, deliberately below UPCitemdb's real 100/day limit.
 * Leaves headroom so our own counter (which can lag the provider's
 * by one IST-midnight/UTC-midnight rollover skew) never actually
 * causes the live key to get throttled or banned.
 */
export const UPC_DAILY_CAP = 90;

/** How long a confirmed "not found" is remembered before retrying — avoids burning quota on repeat scans of the same unknown barcode within a day. */
export const UPC_NEGATIVE_CACHE_TTL_SECONDS = 24 * 60 * 60;
