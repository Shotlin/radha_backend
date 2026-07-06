import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-45 — Image OCR Scan Fallback cache.
 *
 * Per-image dedupe row keyed by `image_sha256`. When the Mobile_App
 * can't decode a barcode within 2 seconds it falls back to a
 * packaging photo upload; the backend then runs Cloud Vision over
 * the image once and reuses the answer for every subsequent request
 * carrying the same image hash. Storing the row regardless of
 * outcome (`matched = false` rows are negative caches) means a
 * second caller for the same image never re-burns Vision quota.
 *
 * The table is intentionally **global** (not tenant-scoped). Image
 * fallback identifies a *product*, not tenant inventory, and the
 * Vision answer is universal — caching it tenant-by-tenant would
 * multiply our cost per Req 38 by N.
 */
export const imageFallbackCache = pgTable(
  'image_fallback_cache',
  {
    ...baseColumns,
    /** sha256 hex digest of the canonical S3 object key (or raw bytes). */
    imageSha256: text('image_sha256').notNull().unique(),
    /** Original S3 object key used for the lookup. Useful for audit / replay. */
    s3ObjectKey: text('s3_object_key').notNull(),
    /** EAN we resolved to, when matched. */
    ean: text('ean'),
    productName: text('product_name'),
    brand: text('brand'),
    /** `'catalog' | 'off' | 'none'` — keeps schema single-source-of-truth aligned with the DTO. */
    source: text('source').notNull().default('none'),
    /** Whether a product was identified for this image. */
    matched: boolean('matched').notNull().default(false),
    /** When the catalog/OFF match was recorded. Null on negative caches. */
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    /** Vision API cost in paise (₹0.001/call → 1 paise). */
    visionCostPaise: integer('vision_cost_paise').notNull().default(0),
    /** Provider identifier (`google-vision`, `mock`, future `self-hosted-ml`). */
    generatedBy: text('generated_by'),
    /** When the Vision call (or cache row) was first created. */
    fetchedAt: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    sha256Idx: index('image_fallback_cache_sha256_idx').on(t.imageSha256),
    s3KeyIdx: index('image_fallback_cache_s3_key_idx').on(t.s3ObjectKey),
    sourceIdx: index('image_fallback_cache_source_idx').on(t.source),
  }),
);

export type ImageFallbackCacheRow = typeof imageFallbackCache.$inferSelect;
export type NewImageFallbackCache = typeof imageFallbackCache.$inferInsert;
