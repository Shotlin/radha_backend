import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { VerifiedBadgeController } from './controllers/verified-badge.controller';
import { VerifiedBadgeCron } from './jobs/verified-badge.cron';
import { OHS_SOURCE_PORT, StubOhsSourceAdapter } from './ports/ohs-source.port';
import { PRO_TIER_PORT, StubProTierAdapter } from './ports/pro-tier.port';
import { VerifiedBadgeRepository } from './repositories/verified-badge.repository';
import { BadgeEligibilityService } from './services/badge-eligibility.service';
import { VerifiedBadgeService } from './services/verified-badge.service';

/**
 * BE-52 — RADHA Verified Badge module.
 *
 * Surfaces:
 *   - HTTP `VerifiedBadgeController`
 *       GET /api/v1/badges/me        (tenant-auth)
 *       GET /api/v1/verify/:tenantSlug (public, cached)
 *   - daily cron `VerifiedBadgeCron` (03:00 IST)
 *
 * Wiring notes:
 *   - `AuthModule` provides JwtAuthGuard for the tenant route.
 *   - `ObservabilityModule` brings in AuditLogService + Sentry tracking.
 *   - The OHS lookup and Pro-tier check are bound behind ports so
 *     the badge module never imports BE-30 / BE-28 directly. The
 *     stub adapters ship as the default — replace them in BE-52 v2
 *     once the source modules expose tenant-level totals.
 *   - The cron provider is registered here. `@Cron()` only fires when
 *     `ScheduleModule.forRoot()` (in AppModule) instantiates the
 *     scheduler; importing this module on the API process is harmless.
 *
 * Per the BE-52 brief, this module is NOT registered in
 * `app.module.ts` — the integration step lives in BE-52 handoff.
 */
@Module({
  imports: [AuthModule, ObservabilityModule],
  controllers: [VerifiedBadgeController],
  providers: [
    VerifiedBadgeRepository,
    BadgeEligibilityService,
    VerifiedBadgeService,
    VerifiedBadgeCron,
    {
      provide: OHS_SOURCE_PORT,
      useClass: StubOhsSourceAdapter,
    },
    {
      provide: PRO_TIER_PORT,
      useClass: StubProTierAdapter,
    },
  ],
  exports: [VerifiedBadgeService, VerifiedBadgeRepository],
})
export class VerifiedBadgeModule {}
