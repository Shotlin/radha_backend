import { Injectable } from '@nestjs/common';

/**
 * BE-23 — Variant configuration source of truth.
 *
 * The five variants ship together. Sizes are the **maximum bounding
 * box** — Sharp resizes with `fit: 'inside'` and `withoutEnlargement`,
 * so portrait / landscape source images keep their aspect ratio and
 * never get upscaled past their natural size.
 *
 * Quality settings tuned for WebP:
 *   - Thumbnails / small  → 80 (storage-conscious lists, small icons).
 *   - Medium              → 85 (product detail pages).
 *   - Large               → 90 (fullscreen / zoom view).
 *
 * `format: 'webp'` for every variant. `effort` defaults to 4 — the
 * sweet spot between encode time and compression ratio (libvips
 * benchmark guidance).
 */
export type VariantName = 'thumbnail' | 'small' | 'medium' | 'large';

export interface VariantConfig {
  name: VariantName;
  width: number;
  height: number;
  quality: number;
  format: 'webp';
  effort: number;
}

@Injectable()
export class ImageVariantsService {
  private readonly variants: ReadonlyArray<VariantConfig> = Object.freeze([
    { name: 'thumbnail', width: 150, height: 150, quality: 80, format: 'webp', effort: 4 },
    { name: 'small', width: 400, height: 400, quality: 80, format: 'webp', effort: 4 },
    { name: 'medium', width: 800, height: 800, quality: 85, format: 'webp', effort: 4 },
    { name: 'large', width: 1600, height: 1600, quality: 90, format: 'webp', effort: 4 },
  ]);

  /** All BE-23 variant configs in display order. */
  list(): ReadonlyArray<VariantConfig> {
    return this.variants;
  }

  /** Lookup a single variant by name. */
  get(name: VariantName): VariantConfig {
    const found = this.variants.find((v) => v.name === name);
    if (!found) {
      throw new Error(`Unknown variant: ${name}`);
    }
    return found;
  }

  /** Variant names in display order — convenience for iteration. */
  names(): ReadonlyArray<VariantName> {
    return this.variants.map((v) => v.name);
  }

  /**
   * Build the variant S3 key from the original.
   *
   *   "tenant-x/product/abc/uuid.jpg" + "thumbnail"
   *     → "tenant-x/product/abc/uuid_thumbnail.webp"
   *
   * Variants always end in `.webp` regardless of source extension.
   * Underscore separator — distinct from BE-13's dot-separator
   * `<key>.<variant>.<ext>` used by `CloudFrontService.getVariantUrl`
   * for backward compatibility, so the new variants live alongside
   * any pre-BE-23 ones without colliding.
   */
  buildVariantKey(originalKey: string, variantName: VariantName): string {
    const lastSlash = originalKey.lastIndexOf('/');
    const lastDot = originalKey.lastIndexOf('.');
    const dirEnd = lastSlash + 1;
    const baseEnd = lastDot > lastSlash ? lastDot : originalKey.length;
    const dir = originalKey.slice(0, dirEnd);
    const base = originalKey.slice(dirEnd, baseEnd);
    return `${dir}${base}_${variantName}.webp`;
  }
}
