import { Module } from '@nestjs/common';

import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { AuthModule } from '@/modules/auth/auth.module';

import { WeeklyDigestCron } from './jobs/weekly-digest.cron';
import {
  SCANS_SOURCE_TOKEN,
  StubScansSourceAdapter,
} from './ports/scans-source.port';
import { WeeklyDigestRepository } from './repositories/weekly-digest.repository';
import { DigestPayloadBuilderService } from './services/digest-payload-builder.service';
import { WeeklyDigestService } from './services/weekly-digest.service';
import { WeeklyDigestController } from './weekly-digest.controller';

/**
 * BE-54 — Weekly Digest module.
 *
 * Responsibilities:
 *   - cron `WeeklyDigestCron`              → fires Sunday 08:00 IST
 *   - service `WeeklyDigestService`        → orchestrates the run
 *   - service `DigestPayloadBuilderService`→ aggregates stats
 *   - repo    `WeeklyDigestRepository`     → table access
 *   - port    `SCANS_SOURCE_TOKEN`         → injectable analytics
 *                                            adapter (defaulted to
 *                                            the stub here so the
 *                                            module is usable
 *                                            stand-alone).
 *
 * Imports:
 *   - `NotificationsModule` exports `NotificationsService` and
 *     `PreferenceManagerService` — both are consumed directly by
 *     `WeeklyDigestService`.
 *   - `ObservabilityModule` provides `AuditLogService` and the
 *     `ERROR_TRACKING_SERVICE` token used by the cron wrapper.
 *
 * Per the BE-54 brief, this module is NOT registered in
 * `app.module.ts` — that step lives in the BE-54 handoff doc.
 * Until it is, importing this file is harmless: the `@Cron`
 * decorator only fires when `ScheduleModule.forRoot()` (already
 * registered in `AppModule`) wires the registrar against the
 * scheduler entrypoint.
 */
@Module({
  imports: [NotificationsModule, ObservabilityModule, AuthModule],
  controllers: [WeeklyDigestController],
  providers: [
    WeeklyDigestRepository,
    DigestPayloadBuilderService,
    WeeklyDigestService,
    WeeklyDigestCron,
    StubScansSourceAdapter,
    {
      provide: SCANS_SOURCE_TOKEN,
      useExisting: StubScansSourceAdapter,
    },
  ],
  exports: [WeeklyDigestService, DigestPayloadBuilderService],
})
export class WeeklyDigestModule {}
