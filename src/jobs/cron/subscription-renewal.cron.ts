import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LoggerService } from '@/logging/logger.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { SubscriptionsRepository } from '@/modules/subscriptions/repositories/subscriptions.repository';
import { UpgradeService } from '@/modules/subscriptions/services/upgrade.service';

/**
 * BE-28 — Subscription renewal cron.
 *
 * Runs daily at 02:00 IST (`0 2 * * *` with `Asia/Kolkata`):
 *   1. Renew active subscriptions whose period has elapsed; if a
 *      pending downgrade is staged, swap the plan at the same time.
 *   2. Expire cancelled subscriptions whose period has elapsed.
 *   3. Send a `subscription-renewal` reminder to subscriptions whose
 *      `next_billing_date` is within 3 days — via BE-24's
 *      `sendTemplate('subscription-renewal', …)`.
 *
 * Schedule choice: 02:00 IST sits before the existing
 * `expiry-status-update` UTC 02:00 sweep and well before the
 * `trial-expiry` 09:00 IST reminder, so renewals settle first and
 * the trial cron sees fresh state. Failures per-subscription are
 * logged + counted but never re-thrown — the cron is best-effort.
 */
@Injectable()
export class SubscriptionRenewalCron {
  private readonly logger = new Logger(SubscriptionRenewalCron.name);

  constructor(
    private readonly upgrade: UpgradeService,
    private readonly subRepo: SubscriptionsRepository,
    private readonly notifications: NotificationsService,
    private readonly appLogger: LoggerService,
  ) {}

  @Cron('0 2 * * *', { name: 'subscription-renewal', timeZone: 'Asia/Kolkata' })
  async run(): Promise<void> {
    this.logger.log('subscription-renewal: starting');

    let renewed = 0;
    let applied = 0;
    let expired = 0;
    try {
      const result = await this.upgrade.runRenewalsForDate();
      renewed = result.renewed;
      applied = result.applied;
      expired = result.expired;
    } catch (err) {
      this.appLogger.error('cron.subscription-renewal.runRenewals.failed', {
        message: err instanceof Error ? err.message : 'unknown',
      });
    }

    let reminded = 0;
    try {
      reminded = await this.sendUpcomingRenewalReminders();
    } catch (err) {
      this.appLogger.error('cron.subscription-renewal.reminders.failed', {
        message: err instanceof Error ? err.message : 'unknown',
      });
    }

    this.appLogger.info('cron.subscription-renewal.completed', {
      renewed,
      applied,
      expired,
      reminded,
    });
  }

  /**
   * Send a `subscription-renewal` notification to active subs whose
   * billing date is within the next 3 days.
   *
   * Idempotency: the row's `metadata.renewalNotified` flag is set
   * when a reminder is sent so re-runs in the same window don't
   * duplicate.
   */
  private async sendUpcomingRenewalReminders(): Promise<number> {
    const now = new Date();
    const lookahead = new Date(now);
    lookahead.setDate(lookahead.getDate() + 3);

    // Active subs whose `currentPeriodEnd` lands inside the 3-day
    // window — `findRenewalsDue` returns "due on or before X", so
    // we filter to the strictly upcoming bucket.
    const dueWithinLookahead = await this.subRepo.findRenewalsDue(lookahead);
    const upcomingOnly = dueWithinLookahead.filter((s) => s.currentPeriodEnd > now);

    let count = 0;
    for (const sub of upcomingOnly) {
      const meta =
        typeof sub.metadata === 'object' && sub.metadata !== null
          ? (sub.metadata as Record<string, unknown>)
          : {};
      if (meta.renewalNotified) continue;

      const ownerId = sub.createdBy ?? sub.tenantId;
      await this.notifications
        .sendTemplate(
          'subscription-renewal',
          [{ userId: ownerId }],
          {
            planName: sub.planCode,
            renewsAt: sub.currentPeriodEnd.toISOString(),
            amount: `₹${Number(sub.monthlyAmount)}`,
          },
          { tenantId: sub.tenantId },
        )
        .catch((err: unknown) => {
          this.appLogger.warn('cron.subscription-renewal.notify.failed', {
            subscriptionId: sub.id,
            tenantId: sub.tenantId,
            message: err instanceof Error ? err.message : 'unknown',
          });
        });
      await this.subRepo.update(sub.id, {
        metadata: { ...meta, renewalNotified: now.toISOString() },
      });
      count += 1;
    }
    return count;
  }
}
