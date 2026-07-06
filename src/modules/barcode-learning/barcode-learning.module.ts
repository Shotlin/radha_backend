import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { MediaModule } from '@/modules/media/media.module';
import { ProductsModule } from '@/modules/products/products.module';
import { ObservabilityModule } from '@/observability/observability.module';

// Note: `CloudFrontService` (used by `BarcodeLearningService` to resolve
// submission image URLs) comes from the `@Global()` `AwsModule` — no
// explicit import needed here. `MediaModule` is imported for
// `MediaService`, which `ConsumerSubmissionController` delegates to
// for the submission-photo presign/confirm pair (BE-56 v2).

import { AdminSubmissionController } from './controllers/admin-submission.controller';
import { ConsumerSubmissionController } from './controllers/consumer-submission.controller';
import { PRODUCTS_CATALOG_PORT } from './ports/products-catalog.port';
import { RealProductsCatalogAdapter } from './ports/real-products-catalog.adapter';
import { FlagRepository } from './repositories/flag.repository';
import { SubmissionRepository } from './repositories/submission.repository';
import { BarcodeLearningService } from './services/barcode-learning.service';
import { FlagTrackerService } from './services/flag-tracker.service';

/**
 * BE-56 — Community Barcode Learning module.
 *
 * Wires the consumer-facing submission/flag endpoints, the admin
 * moderation queue, and the supporting service + repository layer.
 *
 * `PRODUCTS_CATALOG_PORT` is bound to `RealProductsCatalogAdapter`
 * (BE-56 v2), which composes `ProductsModule`'s already-existing
 * repositories — approved submissions land in the same global
 * (`tenant_id = NULL`) `products`/`product_nutrition` rows the
 * product-lookup chain checks first, so they become searchable with
 * no separate lookup-path change. `StubProductsCatalogAdapter` (see
 * `ports/products-catalog.port.ts`) is kept for tests that want to
 * avoid a DB dependency.
 */
@Module({
  imports: [AuthModule, ObservabilityModule, ProductsModule, MediaModule],
  controllers: [ConsumerSubmissionController, AdminSubmissionController],
  providers: [
    SubmissionRepository,
    FlagRepository,
    FlagTrackerService,
    BarcodeLearningService,
    RealProductsCatalogAdapter,
    {
      provide: PRODUCTS_CATALOG_PORT,
      useExisting: RealProductsCatalogAdapter,
    },
  ],
  exports: [BarcodeLearningService],
})
export class BarcodeLearningModule {}
