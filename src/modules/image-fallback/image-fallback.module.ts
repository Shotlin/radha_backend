import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { ImageFallbackController } from './controllers/image-fallback.controller';
import {
  IOffLookupPort,
  OFF_LOOKUP_PORT,
  OffLookupResult,
} from './ports/off-lookup.port';
import {
  IProductsLookupPort,
  PRODUCTS_LOOKUP_PORT,
  ProductsLookupResult,
} from './ports/products-lookup.port';
import { ImageCacheService } from './services/image-cache.service';
import { ImageFallbackService } from './services/image-fallback.service';
import { VisionOcrService } from './services/vision-ocr.service';

/**
 * Default `IProductsLookupPort` binding.
 *
 * Returns `null` for every lookup so the pipeline falls straight
 * through to OFF. The real Drizzle-backed adapter will replace this
 * binding from the BE-45 handoff once `ProductsRepository` exposes
 * `findByNameBrand`.
 */
class NoopProductsLookupAdapter implements IProductsLookupPort {
  async findByNameBrand(_input: {
    name: string;
    brand?: string;
  }): Promise<ProductsLookupResult | null> {
    return null;
  }
}

/**
 * Default `IOffLookupPort` binding.
 *
 * Returns `null` for every lookup. Replaced by the BE-11 v2 OFF
 * adapter at handoff time.
 */
class NoopOffLookupAdapter implements IOffLookupPort {
  async findByNameBrand(_input: {
    name: string;
    brand?: string;
  }): Promise<OffLookupResult | null> {
    return null;
  }
}

/**
 * BE-45 — Image OCR Scan Fallback module.
 *
 * Surfaces:
 *   - HTTP `ImageFallbackController`
 *     (POST /api/v1/scan/image-fallback)
 *
 * Module wiring:
 *   - `AuthModule`           → JwtAuthGuard for the controller.
 *   - `ObservabilityModule`  → Sentry / no-op error tracking +
 *                              audit log (already global, imported
 *                              here for clarity).
 *
 * Ports:
 *   - `PRODUCTS_LOOKUP_PORT` defaults to a no-op stub. Production
 *     wiring overrides this with a Drizzle-backed adapter that
 *     queries `ProductsRepository.findByNameBrand` once that method
 *     exists.
 *   - `OFF_LOOKUP_PORT` defaults to a no-op stub. Production wiring
 *     overrides with the BE-11 v2 OFF integration adapter.
 *
 * Per the BE-45 brief, this module is intentionally NOT registered
 * in `app.module.ts` — that step lives in the BE-45 handoff doc.
 */
@Module({
  imports: [AuthModule, ObservabilityModule],
  controllers: [ImageFallbackController],
  providers: [
    ImageCacheService,
    VisionOcrService,
    {
      provide: PRODUCTS_LOOKUP_PORT,
      useClass: NoopProductsLookupAdapter,
    },
    {
      provide: OFF_LOOKUP_PORT,
      useClass: NoopOffLookupAdapter,
    },
    ImageFallbackService,
  ],
  exports: [ImageFallbackService, ImageCacheService, VisionOcrService],
})
export class ImageFallbackModule {}
