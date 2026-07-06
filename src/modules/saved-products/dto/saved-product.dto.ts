/**
 * Saved Products — response DTO.
 *
 * Locked contract shipped to the FE-16 mobile screen. ISO date /
 * datetime fields are serialised as strings (date columns as
 * `YYYY-MM-DD`, timestamp columns as full ISO 8601) so the Flutter
 * client decodes them with a single `DateTime.parse`.
 */
export interface SavedProductDto {
  id: string;
  userId: string;
  productName: string;
  productId: string | null;
  barcode: string | null;
  /** ISO date `YYYY-MM-DD` or `null`. */
  expiresAt: string | null;
  /** ISO datetime or `null` when the user hasn't marked it consumed. */
  markedConsumedAt: string | null;
  notes: string | null;
  /** ISO datetime — server-stamped. */
  createdAt: string;
  /** ISO datetime — server-stamped. */
  updatedAt: string;
}

/**
 * List response envelope for `GET /api/v1/saved-products`.
 *
 * `nextCursor` is `null` once the caller has reached the end of the
 * collection. Cursors are opaque base64url strings — the mobile
 * client must not parse them, just round-trip them.
 */
export interface SavedProductListResponseDto {
  items: SavedProductDto[];
  nextCursor: string | null;
}
