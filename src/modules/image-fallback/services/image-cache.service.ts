import { createHash } from 'node:crypto';

import { Injectable, Optional } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  ImageFallbackCacheRow,
  NewImageFallbackCache,
  imageFallbackCache,
} from '@/db/schema/image-fallback-cache';

/**
 * BE-45 — Image hash + persistence helpers for the OCR fallback.
 *
 * Two responsibilities:
 *
 *   1. **Hash** — derive a deterministic SHA-256 from whatever
 *      uniquely identifies the uploaded image. We hash the
 *      `s3ObjectKey` itself (cheap, no need to download the bytes
 *      twice) — same key from the same upload session always
 *      collapses to the same cache row, even across pods.
 *
 *   2. **Cache** — insert and look up `image_fallback_cache` rows.
 *      The `DbService` dependency is `@Optional()` so tests can stand
 *      this service up without a database; missing DB short-circuits
 *      lookups to `null` and silently no-ops persistence.
 */
@Injectable()
export class ImageCacheService {
  constructor(@Optional() private readonly db?: DbService) {}

  /**
   * Hash the canonical key. Production callers may switch to a
   * content-hash (sha256 of bytes) once we want true byte-level
   * dedupe; the public API stays `Promise<string>` so the swap is
   * non-breaking.
   */
  hash(s3ObjectKey: string): string {
    if (!s3ObjectKey) {
      throw new Error('image-cache.service: s3ObjectKey is required for hashing');
    }
    return createHash('sha256').update(s3ObjectKey).digest('hex');
  }

  async findByHash(imageSha256: string): Promise<ImageFallbackCacheRow | null> {
    if (!this.db) return null;
    const rows = await this.db
      .getDb()
      .select()
      .from(imageFallbackCache)
      .where(eq(imageFallbackCache.imageSha256, imageSha256))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Insert a cache row idempotently. Concurrent callers for the
   * same image race on the unique `image_sha256` constraint and the
   * loser silently re-reads — both end up with a consistent row.
   */
  async upsert(data: NewImageFallbackCache): Promise<ImageFallbackCacheRow> {
    if (!this.db) {
      // No DB — return a synthetic row so callers don't crash. Tests
      // that need persistence inject a real DbService.
      return {
        id: '00000000-0000-0000-0000-000000000000',
        createdAt: new Date(),
        updatedAt: new Date(),
        imageSha256: data.imageSha256,
        s3ObjectKey: data.s3ObjectKey,
        ean: data.ean ?? null,
        productName: data.productName ?? null,
        brand: data.brand ?? null,
        source: data.source ?? 'none',
        matched: data.matched ?? false,
        matchedAt: data.matchedAt ?? null,
        visionCostPaise: data.visionCostPaise ?? 0,
        generatedBy: data.generatedBy ?? null,
        fetchedAt: data.fetchedAt ?? new Date(),
      } as ImageFallbackCacheRow;
    }

    const inserted = await this.db
      .getDb()
      .insert(imageFallbackCache)
      .values(data)
      .onConflictDoNothing({ target: imageFallbackCache.imageSha256 })
      .returning();

    if (inserted[0]) return inserted[0];

    const existing = await this.findByHash(data.imageSha256);
    if (!existing) {
      throw new Error(
        `image_fallback_cache row missing after conflict for hash ${data.imageSha256}`,
      );
    }
    return existing;
  }
}
