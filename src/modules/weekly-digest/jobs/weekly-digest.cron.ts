import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LoggerService } from '@/logging/logger.service';
import {
  ERROR_TRACKING_SERVICE,
  IErrorTrackingService,
} from '@/observability/error-tracking.types';

import { WeeklyDigestService } from '../services/weekly-digest.service';

/**
 * BE-54 — Weekly digest cron.
 *
 * Schedule: every Sunday 08:00 IST. The hour was chosen to give
 * upstream BE-29 analytics rollups a full overnight window to
 * settle and to land in the consumer's inbox before the typical
 * Sunday morning phone-check.
 *
 * The job is intentionally a thin wrapper: any meaningful state
 * lives in `WeeklyDigestService.runForWeek`. We catch and report
 * unhandled exceptions to the error-tracking service so a single
 * bad row doesn't silently kill the entire digest run.
 *
 * Idempotency: if the cron fires twice in the same week (manual
 * re-run, scheduler restart), the unique constraint on
 * `(user_id, week_starting)` plus the `existsForWeek` fast path
 * guarantee no duplicate digests are produced.
 */
@Injectable()
export class WeeklyDigestCron {
  private readonly logger = new Logger(WeeklyDigestCron.name);

  constructor(
    private readonly service: WeeklyDigestService,
    private readonly appLogger: LoggerService,
    @Inject(ERROR_TRACKING_SERVICE)
    private readonly errorTracking: IErrorTrackingService,
  ) {}

  @Cron('0 8 * * SUN', {
    name: 'weekly-digest',
    timeZone: 'Asia/Kolkata',
  })
  async runWeeklyDigest(): Promise<void> {
    this.appLogger.info('cron.weekly-digest.started');
    try {
      const report = await this.service.runForWeek();
      this.appLogger.info('cron.weekly-digest.completed', { ...report });
    } catch (err) {
      this.logger.error('cron.weekly-digest.unhandled', err as Error);
      this.appLogger.error('cron.weekly-digest.unhandled', {
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      this.errorTracking.captureException(err as Error, {
        module: 'weekly-digest',
        metadata: { phase: 'cron-wrapper' },
      });
    }
  }
}
