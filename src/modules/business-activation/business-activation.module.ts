import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { AnalyticsModule } from '@/modules/analytics/analytics.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { SubscriptionsModule } from '@/modules/subscriptions/subscriptions.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { BusinessActivationController } from './controllers/business-activation.controller';
import { BusinessActivationService } from './services/business-activation.service';
import { TouchpointCounterService } from './services/touchpoint-counter.service';
import { TouchpointRulesService } from './services/touchpoint-rules.service';
import { Day7PushJob } from './jobs/day7-push.job';

/**
 * BE-35 — Business Activation module.
 *
 * Delivers the conversion engine: `POST /api/v1/account/activate-business`
 * upgrades a Consumer → Owner with tenant + store creation, and
 * `GET /api/v1/account/touchpoints` returns which activation surfaces
 * should be displayed.
 *
 * Imports:
 *   - AuthModule          → BE-08 guard stack + decorators
 *   - SubscriptionsModule → Trial Pro start flow (BE-28)
 *   - AnalyticsModule     → business_mode_activated event (BE-29)
 *   - NotificationsModule → Day-7 push (BE-24)
 *   - ObservabilityModule → AuditLogService
 */
@Module({
  imports: [
    AuthModule,
    SubscriptionsModule,
    AnalyticsModule,
    NotificationsModule,
    ObservabilityModule,
  ],
  controllers: [BusinessActivationController],
  providers: [
    BusinessActivationService,
    TouchpointRulesService,
    TouchpointCounterService,
    Day7PushJob,
  ],
  exports: [BusinessActivationService, TouchpointRulesService, TouchpointCounterService],
})
export class BusinessActivationModule {}
