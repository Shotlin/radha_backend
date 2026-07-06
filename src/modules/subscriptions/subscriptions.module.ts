import { Module, Provider } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { EntitlementGuard } from './guards/entitlement.guard';
import { PlanEntitlementsRepository } from './repositories/plan-entitlements.repository';
import { PlansRepository } from './repositories/plans.repository';
import { SubscriptionEventsRepository } from './repositories/subscription-events.repository';
import { SubscriptionsRepository } from './repositories/subscriptions.repository';
import { EntitlementService } from './services/entitlement.service';
import { PlanService } from './services/plan.service';
import { TrialService } from './services/trial.service';
import { UpgradeService } from './services/upgrade.service';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { SUBSCRIPTIONS_SERVICE_TOKEN } from './types/integration.tokens';

/**
 * BE-28 — Subscriptions module.
 *
 * Imports:
 *   - AuthModule          → BE-08 guard stack used by the controller.
 *   - ObservabilityModule → AuditLogService for every state change.
 *
 * Notifications + Cron registration:
 *   The actual cron classes (`TrialExpiryCron`, `SubscriptionRenewalCron`)
 *   live under `src/jobs/cron/` and are registered by `JobsModule`.
 *   This module exports the services they need (`TrialService`,
 *   `UpgradeService`) plus the public `SubscriptionsService` so the
 *   trial cron can call `notifications.sendTemplate('trial-expiring', …)`.
 *
 * Cross-phase contract:
 *   `SUBSCRIPTIONS_SERVICE_TOKEN` (mirrors BE-26 `INVENTORY_SERVICE_TOKEN`)
 *   binds to `SubscriptionsService` so BE-29 / BE-30 / BE-31 can
 *   import the interface without forcing a hard dependency on this
 *   module's concrete classes.
 */

const subscriptionsServiceTokenProvider: Provider = {
  provide: SUBSCRIPTIONS_SERVICE_TOKEN,
  useExisting: SubscriptionsService,
};

@Module({
  imports: [AuthModule, ObservabilityModule],
  controllers: [SubscriptionsController],
  providers: [
    /* Repositories */
    PlansRepository,
    PlanEntitlementsRepository,
    SubscriptionsRepository,
    SubscriptionEventsRepository,

    /* Sub-services */
    PlanService,
    TrialService,
    EntitlementService,
    UpgradeService,

    /* Public facade + guard */
    SubscriptionsService,
    EntitlementGuard,

    /* Cross-phase token binding */
    subscriptionsServiceTokenProvider,
  ],
  exports: [
    SubscriptionsService,
    PlanService,
    TrialService,
    UpgradeService,
    EntitlementService,
    EntitlementGuard,
    PlansRepository,
    PlanEntitlementsRepository,
    SubscriptionsRepository,
    SubscriptionEventsRepository,
    SUBSCRIPTIONS_SERVICE_TOKEN,
  ],
})
export class SubscriptionsModule {}
