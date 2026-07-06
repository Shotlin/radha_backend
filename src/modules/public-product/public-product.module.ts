import { Module, forwardRef } from '@nestjs/common';

import { HealthScoringModule } from '@/modules/health-scoring/health-scoring.module';

import { PublicProductController } from './controllers/public-product.controller';
import { PublicProductService } from './services/public-product.service';
import { SlugService } from './services/slug.service';

/**
 * BE-51 — Public Product Profile Pages (SEO).
 *
 * Wires:
 *   - `PublicProductController` for the two public REST endpoints
 *     (`GET /api/v1/public/products/:slug`,
 *     `GET /api/v1/public/products/sitemap.xml`).
 *   - `PublicProductService` for the read-side projection plus the
 *     410 Gone gating on withdrawn / unsafe products.
 *   - `SlugService` for slug generation and the backfill helper —
 *     consumed by BE-11 (OFF import) and the BE-31 daily scheduler
 *     so freshly imported global products get a slug automatically.
 *
 * `HealthScoringModule` is imported via `forwardRef` so the public
 * profile can include the latest BE-12 health label / score without
 * creating a circular dependency through `ProductsModule`.
 *
 * Per the BE-51 brief this module is NOT registered in
 * `app.module.ts` — that step lives in the BE-51 handoff doc.
 */
@Module({
  imports: [forwardRef(() => HealthScoringModule)],
  controllers: [PublicProductController],
  providers: [PublicProductService, SlugService],
  exports: [PublicProductService, SlugService],
})
export class PublicProductModule {}
