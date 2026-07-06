/**
 * UPCitemdb API types.
 *
 * Different envelope from the Open-*-Facts family: `{code, total,
 * offset, items[]}` instead of `{status, product}`. Only the fields
 * RADHA's mapper consumes are typed.
 */

export interface UpcItem {
  ean?: string;
  upc?: string;
  title?: string;
  description?: string;
  brand?: string;
  category?: string;
  images?: string[];
}

export interface UpcLookupResponse {
  /** `'OK'` on success (even for a zero-result search); `'INVALID_UPC'` etc. on a bad request. */
  code: string;
  total: number;
  offset: number;
  items?: UpcItem[];
}

export interface UpcStats {
  totalRequests: number;
  quotaSkips: number;
  negativeCacheHits: number;
  apiSuccess: number;
  apiFailures: number;
  circuitState: 'closed' | 'open' | 'half-open';
}
