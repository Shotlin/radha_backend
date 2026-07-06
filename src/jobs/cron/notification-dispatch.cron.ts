import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { LoggerService } from '@/logging/logger.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';

/**
 * BE-24 — Notification dispatch sweeper.
 *
 * Runs every minute. Finds rows in `notifications` whose
 * `scheduled_for` has passed but which haven't been dispatched yet
 * (e.g. produced by `send()` while the BullMQ queue was offline,
 * or whose quiet-hours-deferred slot has now arrived) and re-enqueues
 * them through `NotificationsService.dispatchDue`.
 *
 * Acts as a recovery path: even if Redis is unreachable for several
 * minutes, the worker process catches up the moment it is back.
 *
 * Schedule choice: every minute. The overhead is one indexed read on
 * `notifications_scheduled_idx` and is bounded by a `LIMIT 200`.
 */
@Injectable()
export class NotificationDispatchCron {
  private readonly logger = new Logger(NotificationDispatchCron.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly appLogger: LoggerService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'notification-dispatch' })
  async run(): Promise<void> {
    try {
      const result = await this.notifications.dispatchDue();
      if (result.scanned > 0) {
        this.appLogger.info('cron.notification-dispatch.swept', result);
      }
    } catch (err) {
      this.logger.error('cron.notification-dispatch.failed', err as Error);
    }
  }
}
