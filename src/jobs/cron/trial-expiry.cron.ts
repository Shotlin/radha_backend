import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LoggerService } from '@/logging/logger.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { TrialService } from '@/modules/subscriptions/services/trial.service';

const TRIAL_EXPIRY_REMINDER_DAYS = [7, 3, 1];

/**
 * BE-28 — Trial expiry cron.
 *
 * Runs daily at 09:00 IST (`0 9 * * *` with `Asia/Kolkata`):
 *   1. For each of {7, 3, 1} days remaining, find every trial whose
 *      `trial_ends_at` falls in that bucket and send the
 *      `trial-expiring` notification template (BE-24). The
 *      `markExpiringNotified` helper makes the bucket idempotent —
 *      if the cron runs twice in a day (replay, recovery), no
 *      duplicate notifications go out.
 *   2. Sweep trials whose `trial_ends_at` has elapsed and flip them
 *      to `expired`.
 *
 * Errors are logged but never re-thrown; the cron is best-effort.
 */
@Injectable()
export class TrialExpiryCron {
  private readonly logger = new Logger(TrialExpiryCron.name);

  constructor(
    private readonly trial: TrialService,
    private readonly notifications: NotificationsService,
    private readonly appLogger: LoggerService,
  ) {}

  @Cron('0 9 * * *', { name: 'trial-expiry', timeZone: 'Asia/Kolkata' })
  async run(): Promise<void> {
    this.logger.log('trial-expiry: starting');

    let notified = 0;
    for (const days of TRIAL_EXPIRY_REMINDER_DAYS) {
      try {
        const subs = await this.trial.findExpiringIn(days);
        for (const sub of subs) {
          try {
            // BE-09 onboarding ties tenant.created_by to the owner user;
            // we send the trial-expiring notification to that owner so
            // upgrade conversion stays in their inbox. The `userId`
            // resolution happens inside the notifications router via
            // the recipient's email/mobile lookup.
            const ownerId = sub.createdBy ?? sub.tenantId;
            await this.notifications
              .sendTemplate(
                'trial-expiring',
                [{ userId: ownerId }],
                {
                  daysRemaining: days,
                  upgradeLink: '/subscriptions/upgrade',
                },
                { tenantId: sub.tenantId },
              )
              .catch((err: unknown) => {
                this.appLogger.warn('cron.trial-expiry.notify.failed', {
                  subscriptionId: sub.id,
                  tenantId: sub.tenantId,
                  days,
                  message: err instanceof Error ? err.message : 'unknown',
                });
              });

            await this.trial.markExpiringNotified(sub.id, sub.tenantId, days);
            notified += 1;
          } catch (err) {
            this.appLogger.error('cron.trial-expiry.row.failed', {
              subscriptionId: sub.id,
              tenantId: sub.tenantId,
              days,
              message: err instanceof Error ? err.message : 'unknown',
            });
          }
        }
      } catch (err) {
        this.appLogger.error('cron.trial-expiry.bucket.failed', {
          days,
          message: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    let expired = 0;
    try {
      expired = await this.trial.expireTrials();
    } catch (err) {
      this.appLogger.error('cron.trial-expiry.sweep.failed', {
        message: err instanceof Error ? err.message : 'unknown',
      });
    }

    this.appLogger.info('cron.trial-expiry.completed', { notified, expired });
  }
}
