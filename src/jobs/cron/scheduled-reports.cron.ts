import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { LoggerService } from '@/logging/logger.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { ReportSchedulesRepository } from '@/modules/reports/repositories/report-schedules.repository';
import { ReportsService } from '@/modules/reports/reports.service';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

/**
 * BE-24 — Scheduled-reports cron.
 *
 * Runs every 30 minutes. Picks up `report_schedules` rows whose
 * `next_run_at` has passed, fires the report generation through
 * `ReportsService.runFromSchedule`, then notifies recipients via
 * `NotificationsService.sendBulk` once the run kicks off.
 *
 * Schedule choice: 30-minute granularity is enough for human-grade
 * "daily / weekly / monthly" cadences (BE-20 only allows hour-of-day
 * resolution on schedules). Running every 5 minutes would cost more
 * Redis traffic without buying anything visible to users.
 *
 * Per-schedule isolation: one bad schedule cannot strand the rest;
 * each is wrapped in its own try/catch with structured logging.
 */
@Injectable()
export class ScheduledReportsCron {
  private readonly logger = new Logger(ScheduledReportsCron.name);

  constructor(
    private readonly schedulesRepo: ReportSchedulesRepository,
    private readonly reports: ReportsService,
    private readonly notifications: NotificationsService,
    private readonly appLogger: LoggerService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'scheduled-reports' })
  async run(): Promise<void> {
    const now = new Date();

    let due: Array<{
      id: string;
      tenantId: string;
      title: string;
      recipients: string[] | null;
      parameters: unknown;
    }> = [];
    try {
      due = (await this.schedulesRepo.findDueAt(now)) as typeof due;
    } catch (err) {
      this.appLogger.error('cron.scheduled-reports.lookup.failed', {
        message: err instanceof Error ? err.message : 'unknown',
      });
      return;
    }

    if (due.length === 0) return;

    this.logger.log(`scheduled-reports: ${due.length} due`);

    let fired = 0;
    let failed = 0;

    for (const schedule of due) {
      try {
        const report = await this.reports.runFromSchedule(
          schedule.tenantId,
          SYSTEM_ACTOR,
          schedule.id,
          schedule.parameters as Parameters<typeof this.reports.runFromSchedule>[3],
        );
        fired += 1;

        const recipients = schedule.recipients ?? [];
        if (recipients.length > 0) {
          await this.notifications
            .sendBulk({
              tenantId: schedule.tenantId,
              userIds: recipients,
              channels: ['in-app'],
              category: 'report',
              subject: `Scheduled report queued: ${schedule.title}`,
              body: `Your scheduled report "${schedule.title}" has been queued. You'll receive another notification when it is ready to download.`,
              relatedResourceType: 'report',
              relatedResourceId: (report as { id?: string } | null | undefined)?.id ?? schedule.id,
              data: { scheduleId: schedule.id },
            })
            .catch((err: unknown) => {
              this.appLogger.warn('cron.scheduled-reports.notify.failed', {
                scheduleId: schedule.id,
                message: err instanceof Error ? err.message : 'unknown',
              });
            });
        }
      } catch (err) {
        failed += 1;
        this.appLogger.error('cron.scheduled-reports.fire.failed', {
          scheduleId: schedule.id,
          tenantId: schedule.tenantId,
          message: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    this.appLogger.info('cron.scheduled-reports.completed', {
      due: due.length,
      fired,
      failed,
    });
  }
}
