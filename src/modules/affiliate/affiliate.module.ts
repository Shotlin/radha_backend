import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { ProductsModule } from '@/modules/products/products.module';

import { AffiliateController } from './controllers/affiliate.controller';
import { AlternativesController } from './controllers/alternatives.controller';
import { AffiliateClickRepository } from './repositories/affiliate-click.repository';
import { AffiliatePartnerRepository } from './repositories/affiliate-partner.repository';
import { AffiliateRevenueRepository } from './repositories/affiliate-revenue.repository';
import { AffiliateLinkService } from './services/affiliate-link.service';
import { AffiliateTrackingService } from './services/affiliate-tracking.service';
import { HealthyAlternativesService } from './services/healthy-alternatives.service';
import { RealProductsLookupAdapterService } from './services/real-products-lookup.adapter';
import { StubProductsLookupAdapter } from './services/stub-products-lookup.adapter';
import { PRODUCTS_LOOKUP_PORT } from './ports/products-lookup.port';

/**
 * BE-41 — Healthy Alternatives + Affiliate Engine module.
 *
 * Surfaces:
 *   - `AlternativesController`   GET  /api/v1/products/:ean/alternatives
 *   - `AffiliateController`      POST /api/v1/affiliate/clicks
 *                                POST /api/v1/affiliate/revenue (HMAC)
 *
 * Module wiring:
 *   - `AuthModule`               — provides `JwtAuthGuard` for the
 *                                  `/clicks` and `/alternatives` routes.
 *                                  Exported guards are reused; nothing
 *                                  new is registered here.
 *   - Repositories               — three Drizzle repositories, one per
 *                                  table (`affiliate_partners`,
 *                                  `affiliate_clicks`, `affiliate_revenue`).
 *   - Services                   — `HealthyAlternativesService`,
 *                                  `AffiliateLinkService`,
 *                                  `AffiliateTrackingService`.
 *   - `PRODUCTS_LOOKUP_PORT`     — bound to `StubProductsLookupAdapter`
 *                                  by default. A real adapter against
 *                                  the products + health-scoring
 *                                  modules can be plugged in later
 *                                  without touching the service layer.
 *
 * Per the BE-41 brief this module is NOT registered in
 * `app.module.ts` — that integration step lives in the BE-41 handoff
 * document. Module-level tests instantiate it directly.
 *
 * `HealthyAlternativesService` and `AffiliateLinkService` are exported
 * so the BE-10 v2 scan endpoint can populate the alternatives slot in
 * its response without re-instantiating the engine.
 */
@Module({
  imports: [AuthModule, ObservabilityModule, ProductsModule],
  controllers: [AlternativesController, AffiliateController],
  providers: [
    AffiliatePartnerRepository,
    AffiliateClickRepository,
    AffiliateRevenueRepository,
    AffiliateLinkService,
    AffiliateTrackingService,
    StubProductsLookupAdapter,
    RealProductsLookupAdapterService,
    {
      provide: PRODUCTS_LOOKUP_PORT,
      useExisting: RealProductsLookupAdapterService,
    },
    HealthyAlternativesService,
  ],
  exports: [
    HealthyAlternativesService,
    AffiliateLinkService,
    AffiliateTrackingService,
    PRODUCTS_LOOKUP_PORT,
    StubProductsLookupAdapter,
    RealProductsLookupAdapterService,
  ],
})
export class AffiliateModule {}
