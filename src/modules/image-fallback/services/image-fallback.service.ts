import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import {
  ERROR_TRACKING_SERVICE,
  IErrorTrackingService,
} from '@/observability/error-tracking.types';

import {
  ImageFallbackDto,
  ImageFallbackResponseDto,
  resolveFallbackLocale,
} from '../dto/image-fallback.dto';
import {
  IOffLookupPort,
  OFF_LOOKUP_PORT,
  OffLookupResult,
} from '../ports/off-lookup.port';
import {
  IProductsLookupPort,
  PRODUCTS_LOOKUP_PORT,
  ProductsLookupResult,
} from '../ports/products-lookup.port';
import { ImageCacheService } from './image-cache.service';
import { VisionOcrService, VisionOcrResult } from './vision-ocr.service';

/**
 * BE-45 — Image OCR Scan Fallback orchestrator.
 *
 * Pipeline (per the phase brief):
 *
 *   1. Validate `s3ObjectKey` — already done by the DTO; we re-guard
 *      here for callers that bypass the controller (tests, future
 *      worker invocations).
 *   2. Hash the key. The hash is the cache row's primary lookup key.
 *   3. Cache hit → return the cached scan output directly. No Vision
 *      call, no catalog hit — concurrent uploads of the same image
 *      collapse to a single row and a single cost.
 *   4. Cache miss → call Vision OCR. The mock provider returns a
 *      deterministic name/brand/confidence/cost.
 *   5. Try `ProductsLookupPort.findByNameBrand` — local catalog has
 *      first refusal. Match → persist + return `source: 'catalog'`.
 *   6. Try `OffLookupPort.findByNameBrand` — global fallback. Match
 *      → persist (the port adapter handles the upsert) + return
 *      `source: 'off'`.
 *   7. Neither matched → persist a negative cache row and return
 *      `{ matched: false, source: 'none' }`.
 *
 * Failures during OCR or lookup escape via `IErrorTrackingService`
 * (Sentry / no-op) but never break the user's request — we log,
 * capture, and return a graceful unmatched response.
 */
@Injectable()
export class ImageFallbackService {
  constructor(
    private readonly cache: ImageCacheService,
    private readonly vision: VisionOcrService,
    @Inject(PRODUCTS_LOOKUP_PORT)
    private readonly products: IProductsLookupPort,
    @Inject(OFF_LOOKUP_PORT)
    private readonly off: IOffLookupPort,
    private readonly logger: LoggerService,
    @Optional()
    @Inject(ERROR_TRACKING_SERVICE)
    private readonly errorTracking?: IErrorTrackingService,
  ) {}

  async identify(dto: ImageFallbackDto): Promise<ImageFallbackResponseDto> {
    const s3ObjectKey = dto.s3ObjectKey?.trim();
    if (!s3ObjectKey) {
      throw new BadRequestException({
        code: 'INVALID_S3_OBJECT_KEY',
        message: 's3ObjectKey is required',
      });
    }

    const locale = resolveFallbackLocale(dto.locale);
    const imageSha256 = this.cache.hash(s3ObjectKey);

    // 1. Cache hit — return the persisted answer directly.
    const cached = await this.cache.findByHash(imageSha256).catch((err) => {
      this.captureWarning(err, { phase: 'cache-lookup', imageSha256 });
      return null;
    });
    if (cached) {
      this.logger.info('image_fallback.cache_hit', {
        imageSha256,
        source: cached.source,
        matched: cached.matched,
      });
      return this.toResponse(cached);
    }

    // 2. Cache miss — call Vision OCR.
    let visionResult: VisionOcrResult;
    try {
      visionResult = await this.vision.recognize(s3ObjectKey, locale);
    } catch (err) {
      this.captureException(err, { phase: 'vision-ocr', imageSha256 });
      // Persist a negative-cache row so we don't retry forever.
      await this.persistMiss(s3ObjectKey, imageSha256, 0, undefined);
      return { matched: false, source: 'none', costPaise: 0 };
    }

    // 3. Try local catalog first.
    const catalogHit = await this.tryCatalog(visionResult);
    if (catalogHit) {
      const row = await this.persistMatch(
        s3ObjectKey,
        imageSha256,
        visionResult,
        catalogHit,
        'catalog',
      );
      return this.toResponse(row);
    }

    // 4. Fall back to OFF.
    const offHit = await this.tryOff(visionResult);
    if (offHit) {
      const row = await this.persistMatch(
        s3ObjectKey,
        imageSha256,
        visionResult,
        offHit,
        'off',
      );
      return this.toResponse(row);
    }

    // 5. No match anywhere — persist a negative cache row.
    const row = await this.persistMiss(
      s3ObjectKey,
      imageSha256,
      visionResult.costPaise,
      visionResult.provider,
    );
    return this.toResponse(row);
  }

  /* ──────────────────────── helpers ──────────────────────── */

  private async tryCatalog(
    vision: VisionOcrResult,
  ): Promise<ProductsLookupResult | null> {
    try {
      return await this.products.findByNameBrand({
        name: vision.name,
        brand: vision.brand,
      });
    } catch (err) {
      this.captureWarning(err, { phase: 'catalog-lookup' });
      return null;
    }
  }

  private async tryOff(vision: VisionOcrResult): Promise<OffLookupResult | null> {
    try {
      return await this.off.findByNameBrand({
        name: vision.name,
        brand: vision.brand,
      });
    } catch (err) {
      this.captureWarning(err, { phase: 'off-lookup' });
      return null;
    }
  }

  private async persistMatch(
    s3ObjectKey: string,
    imageSha256: string,
    vision: VisionOcrResult,
    match: ProductsLookupResult | OffLookupResult,
    source: 'catalog' | 'off',
  ) {
    return this.cache.upsert({
      imageSha256,
      s3ObjectKey,
      ean: match.ean,
      productName: match.name,
      brand: match.brand ?? null,
      source,
      matched: true,
      matchedAt: new Date(),
      visionCostPaise: vision.costPaise,
      generatedBy: vision.provider,
    });
  }

  private async persistMiss(
    s3ObjectKey: string,
    imageSha256: string,
    costPaise: number,
    provider: VisionOcrResult['provider'] | undefined,
  ) {
    return this.cache.upsert({
      imageSha256,
      s3ObjectKey,
      source: 'none',
      matched: false,
      visionCostPaise: costPaise,
      generatedBy: provider ?? null,
    });
  }

  private toResponse(row: {
    matched: boolean;
    ean: string | null;
    productName: string | null;
    brand: string | null;
    source: string;
    visionCostPaise: number;
  }): ImageFallbackResponseDto {
    const source = (
      row.source === 'catalog' || row.source === 'off' ? row.source : 'none'
    ) as ImageFallbackResponseDto['source'];
    const base: ImageFallbackResponseDto = {
      matched: row.matched,
      source,
      costPaise: row.visionCostPaise,
    };
    if (row.matched) {
      if (row.ean) base.ean = row.ean;
      if (row.productName) base.productName = row.productName;
      if (row.brand) base.brand = row.brand;
    }
    return base;
  }

  private captureException(err: unknown, metadata: Record<string, unknown>): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.logger.error('image_fallback.exception', {
      error: { name: error.name, message: error.message },
      ...metadata,
    });
    this.errorTracking?.captureException(error, {
      module: 'image-fallback',
      metadata,
    });
  }

  private captureWarning(err: unknown, metadata: Record<string, unknown>): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.logger.warn('image_fallback.warning', {
      error: { name: error.name, message: error.message },
      ...metadata,
    });
  }
}
