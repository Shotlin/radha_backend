/**
 * Open Products Facts (OPF) integration constants.
 *
 * Same organization as Open Food Facts, same v2 API shape, scoped to
 * general/household products not covered by the food or beauty
 * databases. Free, no API key.
 */

export const OPF_BASE_URL = 'https://world.openproductsfacts.org' as const;
export const OPF_API_VERSION = 'v2' as const;
export const OPF_USER_AGENT = 'RADHA-Backend/1.0 (https://radha.app; contact@radha.app)' as const;

/** Default cache lifetime — 30 days. */
export const OPF_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Wall-clock timeout per HTTP request. */
export const OPF_REQUEST_TIMEOUT_MS = 5_000;

/** Number of consecutive failures before the circuit breaker trips. */
export const OPF_CB_FAILURE_THRESHOLD = 5;

/** Successes needed in `half-open` state before transitioning to `closed`. */
export const OPF_CB_SUCCESS_THRESHOLD = 2;

/** Time the circuit stays `open` before allowing a probe request. */
export const OPF_CB_OPEN_DURATION_MS = 60_000;
