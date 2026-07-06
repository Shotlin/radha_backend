/**
 * BE-45 — Open Food Facts lookup port for the image OCR fallback.
 *
 * Wraps the BE-11 OFF integration behind a narrow interface so this
 * module doesn't depend on the (heavy) OFF module wiring just to do
 * a name+brand search. The default-binding adapter in
 * `image-fallback.module.ts` plugs in to the real OFF client; tests
 * inject a stub.
 */

export interface OffLookupResult {
  /** Universal EAN (13 digits) — the value we'll persist. */
  ean: string;
  /** Display name as resolved by OFF. */
  name: string;
  brand?: string;
}

export interface IOffLookupPort {
  /**
   * Look up a product by name + brand on Open Food Facts. Return
   * `null` when OFF has no confident match. Implementations are
   * responsible for upserting the result into the global
   * `products` catalog so subsequent EAN-based lookups short-circuit.
   */
  findByNameBrand(input: {
    name: string;
    brand?: string;
  }): Promise<OffLookupResult | null>;
}

export const OFF_LOOKUP_PORT = Symbol('OFF_LOOKUP_PORT');
