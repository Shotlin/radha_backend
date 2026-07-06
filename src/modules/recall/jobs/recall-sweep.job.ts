import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LoggerService } from '@/logging/logger.service';
import {
  ERROR_TRACKING_SERVICE,
  IErrorTrackingService,
} from '@/observability/error-tracking.types';

import { RecallSweepService } from '../services/recall-sweep.service';

/**
 * BE-39 — Daily `Recall_Sweep_Job`.
 *
 * Schedule: 05:00 IST every day. Runs against the FSSAI feed (and
 * any other adapters wired into `RECALL_FEED_ADAPTERS`), persists
 * new entries, materialises per-user alerts, and fires push
 * notifications.
 *
 * Why 05:00 IST:
 *   - off-peak for the API (consumer reads concentrate in the
 *     evening),
 *   - upstream FSSAI advisories typically land overnight,
 *   - users see a fresh badge by the time they check the app in
 *     the morning.
 *
 * Failure escalation:
 *   - per-source failures are caught in `RecallFeedService.fetchAll`
 *     (Sentry warn).
 *   - a *full* failure (every source failed) or an unexpected
 *     exception out of `runSweep()` is captured here as an
 *     `error`-level Sentry event so the on-call sees a single
 *     well-shaped alert.
 *
 * Idempotency:
 *   - `RecallFeedService.persistFeedEntry` dedupes on the natural
 *     key of an entry,
 *   - `RecallAlertsRepository.createIfMissing` dedupes on
 *     UNIQUE(user_id, recall_feed_entry_id, saved_product_id),
 *   so a manual re-run (or BE-04 test-mode invocation) is safe.
 */
@Injectable()
export class RecallSweepJob {
  private readonly logger = new Logger(RecallSweepJob.name);

  constructor(
    private readonly sweep: RecallSweepService,
    private readonly appLogger: LoggerService,
    @Inject(ERROR_TRACKING_SERVICE)
    private readonly errorTracking: IErrorTrackingService,
  ) {}

  @Cron('0 5 * * *', {
    name: 'recall-sweep',
    timeZone: 'Asia/Kolkata',
  })
  async runDailySweep(): Promise<void> {
    this.appLogger.info('cron.recall-sweep.started');
    try {
      const report = await this.sweep.runSweep();
      this.appLogger.info('cron.recall-sweep.completed', {
        ...report,
        failedSourcesCount: report.failedSources.length,
      });

      // Full-failure escalation: every source died but the job
      // itself didn't throw. Treat this as an error so the on-call
      // sees it (per spec — "Sentry on full failure").
      if (report.failedSources.length > 0 && report.fetched === 0) {
        this.errorTracking.captureMessage(
          'recall.sweep.full-failure: every feed source failed',
          'error',
          {
            module: 'recall',
            metadata: {
              failedSources: report.failedSources,
              durationMs: report.durationMs,
            },
          },
        );
      }
    } catch (err) {
      this.logger.error('cron.recall-sweep.unhandled', err as Error);
      this.appLogger.error('cron.recall-sweep.unhandled', {
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      this.errorTracking.captureException(err as Error, {
        module: 'recall',
        metadata: { phase: 'cron-wrapper' },
      });
    }
  }
}
