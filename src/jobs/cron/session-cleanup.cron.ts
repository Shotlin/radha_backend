import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { LoggerService } from '@/logging/logger.service';
import { ScanSessionService } from '@/modules/scans/services/scan-session.service';
import { TasksService } from '@/modules/tasks/tasks.service';

/**
 * BE-24 — Hourly cleanup cron.
 *
 * Two responsibilities, same heartbeat (no point spinning up two
 * separate cron jobs for hourly bookkeeping):
 *   1. Expire stale scan sessions — `ScanSessionService.expireStaleSessions`
 *      transitions any `active` session whose `lastActivityAt` is
 *      older than the inactivity threshold to `expired`.
 *   2. Mark overdue tasks — `TasksService.markOverdue` flips
 *      `pending`/`in_progress` tasks past their due date to `overdue`.
 *      Runs hourly so the App Owner Dashboard reflects overdue state
 *      with bounded staleness.
 *
 * Schedule choice: every hour on the hour. Cheap operations
 * (indexed scans, no joins), so the smaller window keeps Mobile_App
 * + dashboard state fresh.
 */
@Injectable()
export class SessionCleanupCron {
  private readonly logger = new Logger(SessionCleanupCron.name);

  constructor(
    private readonly sessions: ScanSessionService,
    private readonly tasks: TasksService,
    private readonly appLogger: LoggerService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'session-cleanup' })
  async run(): Promise<void> {
    const now = new Date();

    let expiredSessions = 0;
    try {
      expiredSessions = await this.sessions.expireStaleSessions(now);
    } catch (err) {
      this.appLogger.error('cron.session-cleanup.sessions.failed', {
        message: err instanceof Error ? err.message : 'unknown',
      });
    }

    let overdueTasks: { scanned: number; marked: number } = {
      scanned: 0,
      marked: 0,
    };
    try {
      overdueTasks = await this.tasks.markOverdue(now);
    } catch (err) {
      this.appLogger.error('cron.session-cleanup.tasks.failed', {
        message: err instanceof Error ? err.message : 'unknown',
      });
    }

    if (expiredSessions > 0 || overdueTasks.marked > 0) {
      this.logger.log(
        `session-cleanup: expired=${expiredSessions} overdueTasks=${overdueTasks.marked}/${overdueTasks.scanned}`,
      );
    }
    this.appLogger.info('cron.session-cleanup.completed', {
      expiredSessions,
      overdueTasks,
    });
  }
}
