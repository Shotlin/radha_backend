import { Module } from '@nestjs/common';

import { FcmModule } from '@/integrations/fcm/fcm.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationProcessor } from './processors/notification.processor';
import { DeviceTokensRepository } from './repositories/device-tokens.repository';
import { NotificationPreferencesRepository } from './repositories/notification-preferences.repository';
import { NotificationTemplatesRepository } from './repositories/notification-templates.repository';
import { NotificationsRepository } from './repositories/notifications.repository';
import { EmailNotificationService } from './services/email-notification.service';
import { NotificationRouterService } from './services/notification-router.service';
import { PreferenceManagerService } from './services/preference-manager.service';
import { PushNotificationService } from './services/push-notification.service';
import { SmsNotificationService } from './services/sms-notification.service';
import { TemplateRendererService } from './services/template-renderer.service';

/**
 * BE-24 — Notifications module.
 *
 * Imports:
 *   - AuthModule          → BE-08 guard stack + UsersRepository for
 *                           the contact resolver in `NotificationRouter`.
 *   - ObservabilityModule → AuditLogService + MetricsService (the
 *                           processor emits metric counters).
 *   - FcmModule           → declared explicitly so the FCM provider
 *                           loads even when the global registration
 *                           hasn't run yet (e.g. in unit tests that
 *                           construct this module directly).
 *   - EmailModule + SmsModule are global, so importing them here is
 *     unnecessary; the channel services inject their facades directly.
 *
 * Exported symbols:
 *   - NotificationsService   — the public façade every other module
 *                              uses (BE-15/17/18/19/20/21 already
 *                              defer their notification fan-out to it).
 *   - NotificationProcessor  — registered by `JobsModule` against
 *                              the BullMQ worker.
 *   - PreferenceManagerService — exported so cron jobs (daily-digest)
 *                                can read prefs without a circular
 *                                dependency.
 */
@Module({
  imports: [AuthModule, ObservabilityModule, FcmModule],
  controllers: [NotificationsController],
  providers: [
    /* Repositories */
    NotificationsRepository,
    NotificationPreferencesRepository,
    NotificationTemplatesRepository,
    DeviceTokensRepository,

    /* Sub-services */
    PreferenceManagerService,
    TemplateRendererService,
    EmailNotificationService,
    SmsNotificationService,
    PushNotificationService,
    NotificationRouterService,

    /* Public facade + processor */
    NotificationsService,
    NotificationProcessor,
  ],
  exports: [
    NotificationsService,
    NotificationProcessor,
    PreferenceManagerService,
    TemplateRendererService,
    NotificationsRepository,
    DeviceTokensRepository,
  ],
})
export class NotificationsModule {}
