import { Module, OnModuleInit } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { AnalyticsController } from './analytics.controller';
import { PublicAnalyticsController } from './public-analytics.controller';
import { PublicRateLimitGuard } from './guards/public-rate-limit.guard';
import { AppUsageEventsRepository } from './repositories/app-usage-events.repository';
import { MarketingLeadsRepository } from './repositories/marketing-leads.repository';
import { OwnerDailyMetricsRepository } from './repositories/owner-daily-metrics.repository';
import { WebsiteEventsRepository } from './repositories/website-events.repository';
import { AppAnalyticsService } from './services/app-analytics.service';
import { FunnelService } from './services/funnel.service';
import { LeadsService } from './services/leads.service';
import { OwnerMetricsAggregatorService } from './services/owner-metrics-aggregator.service';
import { WebsiteAnalyticsService } from './services/website-analytics.service';
import { assertValidSalt } from './utils/analytics-hash.util';

/**
 * BE-29 — Analytics & Lead Ingestion module.
 *
 * Imports:
 *   - AuthModule          → BE-08 guard stack
 *   - ObservabilityModule → AuditLogService for lead-status transitions
 *   - NotificationsModule → owner-email fan-out on new leads
 *
 * Exports:
 *   - WebsiteAnalyticsService / AppAnalyticsService / LeadsService /
 *     FunnelService / OwnerMetricsAggregatorService — BE-30 + BE-31
 *     dashboards consume these.
 *   - The cron registration happens in `JobsModule` per the project
 *     convention; that's a flagged orchestrator integration.
 *
 * `onModuleInit` performs a fail-fast check for `ANALYTICS_HASH_SALT`
 * so the API process never accidentally runs with an empty salt and
 * silently writes hashable visitor IDs to disk.
 */
@Module({
  imports: [AuthModule, ObservabilityModule, NotificationsModule],
  controllers: [AnalyticsController, PublicAnalyticsController],
  providers: [
    /* Repositories */
    WebsiteEventsRepository,
    MarketingLeadsRepository,
    AppUsageEventsRepository,
    OwnerDailyMetricsRepository,

    /* Services */
    WebsiteAnalyticsService,
    AppAnalyticsService,
    LeadsService,
    FunnelService,
    OwnerMetricsAggregatorService,

    /* Guards */
    PublicRateLimitGuard,
  ],
  exports: [
    WebsiteAnalyticsService,
    AppAnalyticsService,
    LeadsService,
    FunnelService,
    OwnerMetricsAggregatorService,
    WebsiteEventsRepository,
    MarketingLeadsRepository,
    AppUsageEventsRepository,
    OwnerDailyMetricsRepository,
  ],
})
export class AnalyticsModule implements OnModuleInit {
  onModuleInit(): void {
    // Fail-loud at boot if the salt is missing or weak. We deliberately
    // do not log the salt itself.
    if (process.env.NODE_ENV === 'test') {
      // Tests construct the module directly without loading env files;
      // skip the hard check and let unit tests inject their own salt.
      return;
    }
    assertValidSalt(process.env.ANALYTICS_HASH_SALT);
  }
}
