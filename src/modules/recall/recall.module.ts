import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { RecallController } from './controllers/recall.controller';
import { FssaiFeedAdapter } from './integrations/fssai-feed.adapter';
import { RecallSweepJob } from './jobs/recall-sweep.job';
import { RecallAlertsRepository } from './repositories/recall-alerts.repository';
import { RecallFeedEntriesRepository } from './repositories/recall-feed-entries.repository';
import { RecallFeedService } from './services/recall-feed.service';
import { RecallService } from './services/recall.service';
import { RecallSweepService } from './services/recall-sweep.service';
import { RECALL_FEED_ADAPTERS, type IRecallFeedAdapter } from './types/recall.types';

/**
 * BE-39 — Recall Alerts module.
 *
 * Surfaces:
 *   - HTTP `RecallController` (listing + acknowledging consumer alerts)
 *   - daily cron `RecallSweepJob` (FSSAI feed → match → push)
 *
 * Module wiring:
 *   - `AuthModule`           → JwtAuthGuard for the controller.
 *   - `NotificationsModule`  → `NotificationsService` for push fan-out.
 *   - `ObservabilityModule`  → Sentry + audit log (already global,
 *     imported here for clarity).
 *
 * Adapters are bound to the `RECALL_FEED_ADAPTERS` array provider so
 * adding a new publisher (MoFPI, CDSCO, state regulator) is "drop in
 * a new adapter, append it here". `RecallFeedService` injects the
 * array.
 *
 * The `RecallSweepJob` provider is registered here. It is harmless to
 * import on the API process — `@Cron` decorators only fire when
 * `ScheduleModule.forRoot()` (in `AppModule`) instantiates the schedule
 * registrar; the scheduler entrypoint owns the actual ticker. This
 * module is intentionally NOT registered in `app.module.ts` per the
 * BE-39 brief — the integration step lives in BE-39 handoff/v2.
 */
@Module({
  imports: [AuthModule, NotificationsModule, ObservabilityModule],
  controllers: [RecallController],
  providers: [
    RecallFeedEntriesRepository,
    RecallAlertsRepository,
    FssaiFeedAdapter,
    {
      provide: RECALL_FEED_ADAPTERS,
      inject: [FssaiFeedAdapter],
      useFactory: (fssai: FssaiFeedAdapter): IRecallFeedAdapter[] => [fssai],
    },
    RecallFeedService,
    RecallSweepService,
    RecallService,
    RecallSweepJob,
  ],
  exports: [RecallSweepService, RecallService],
})
export class RecallModule {}
