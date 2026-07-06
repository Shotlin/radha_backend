import { Inject, Injectable } from '@nestjs/common';

import type { RecallFeedEntryRow } from '@/db/schema/recall';
import { LoggerService } from '@/logging/logger.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { AuditLogService } from '@/observability/audit-log.service';
import {
  ERROR_TRACKING_SERVICE,
  IErrorTrackingService,
} from '@/observability/error-tracking.types';

import { RecallAlertsRepository } from '../repositories/recall-alerts.repository';
import { FeedEntryDraft, SavedProductMatch, SweepReport } from '../types/recall.types';

import { RecallFeedService } from './recall-feed.service';

/**
 * BE-39 — Recall sweep orchestrator.
 *
 * One pass:
 *
 *   1. Fetch every registered feed via `RecallFeedService` (with
 *      retry + Sentry on full failure).
 *   2. Persist each entry idempotently.
 *   3. For each entry, find every saved product whose EAN matches.
 *      v1 ships EAN-only matching — brand+name fuzzy and batch-number
 *      matching are slated for v2 once the feed format stabilises
 *      (see Q&A in BE-39_PHASE).
 *   4. For each match, insert a `recall_alerts` row via
 *      `createIfMissing()`. The UNIQUE constraint dedupes replays
 *      so users never get the same notification twice.
 *   5. Send a `recall-alert` push notification per *new* alert.
 *      Re-runs that hit the dedupe constraint silently skip the
 *      notification. The notifications service in turn respects
 *      the user's `Notification_Preferences.recall-alert` toggle.
 *
 * Errors that escape `RecallFeedService` are non-fatal at the
 * source level (one bad publisher doesn't block the others). A
 * sweep is considered a *full failure* only when every source
 * failed — that case is escalated to Sentry separately by the
 * cron job wrapper.
 */
@Injectable()
export class RecallSweepService {
  constructor(
    private readonly feed: RecallFeedService,
    private readonly alerts: RecallAlertsRepository,
    private readonly notifications: NotificationsService,
    private readonly logger: LoggerService,
    private readonly auditLog: AuditLogService,
    @Inject(ERROR_TRACKING_SERVICE)
    private readonly errorTracking: IErrorTrackingService,
  ) {}

  async runSweep(): Promise<SweepReport> {
    const start = Date.now();
    const report: SweepReport = {
      fetched: 0,
      persisted: 0,
      duplicates: 0,
      alertsCreated: 0,
      notificationsSent: 0,
      failedSources: [],
      durationMs: 0,
    };

    const { entries, failedSources } = await this.feed.fetchAll();
    report.fetched = entries.length;
    report.failedSources = failedSources;

    for (const draft of entries) {
      try {
        const { row, created } = await this.feed.persistFeedEntry(draft);
        if (created) report.persisted += 1;
        else report.duplicates += 1;

        await this.processEntry(row, draft, report);
      } catch (err) {
        this.logger.error('recall.sweep.entry.failed', {
          source: draft.source,
          ean: draft.ean,
          error: { name: (err as Error).name, message: (err as Error).message },
        });
        this.errorTracking.captureException(err as Error, {
          module: 'recall',
          metadata: { source: draft.source, phase: 'process-entry' },
        });
      }
    }

    report.durationMs = Date.now() - start;
    this.logger.info('recall.sweep.completed', {
      ...report,
      failedSources: report.failedSources.length,
    });

    return report;
  }

  /** Match a feed entry against saved products and fan out alerts. */
  async processEntry(
    entry: RecallFeedEntryRow,
    draft: FeedEntryDraft,
    report: SweepReport,
  ): Promise<void> {
    const matches = await this.findMatches(draft);
    for (const match of matches) {
      const alert = await this.alerts.createIfMissing({
        tenantId: match.tenantId,
        userId: match.userId,
        savedProductId: match.savedProductId,
        recallFeedEntryId: entry.id,
      });
      if (!alert) {
        // Already existed — UNIQUE(user, entry, product) hit. Don't
        // resend the notification.
        continue;
      }

      report.alertsCreated += 1;

      void this.auditLog.logAction({
        action: 'CREATE',
        resourceType: 'recall_alert',
        resourceId: alert.id,
        tenantId: match.tenantId,
        userId: match.userId,
        success: true,
        metadata: {
          source: entry.source,
          recallFeedEntryId: entry.id,
          savedProductId: match.savedProductId,
        },
      });

      try {
        const productName = entry.productName ?? draft.productName ?? 'A product';
        await this.notifications.send({
          tenantId: match.tenantId,
          userId: match.userId,
          channels: ['push', 'in-app'],
          category: 'recall-alert',
          subject: 'Product Recall',
          body: `${productName} has been recalled: ${entry.reason}`,
          data: {
            alertId: alert.id,
            recallFeedEntryId: entry.id,
            savedProductId: match.savedProductId,
            source: entry.source,
          },
          priority: 'high',
          relatedResourceType: 'recall_alert',
          relatedResourceId: alert.id,
        });
        report.notificationsSent += 1;
      } catch (err) {
        // A failed push is not a sweep-killer; the alert row is the
        // source of truth and the Mobile_App will surface it on next
        // poll. We still capture it so silent FCM regressions don't
        // hide.
        this.logger.warn('recall.sweep.notification.failed', {
          alertId: alert.id,
          userId: match.userId,
          error: { name: (err as Error).name, message: (err as Error).message },
        });
      }
    }
  }

  /**
   * v1 — EAN-only matching. Future iterations will add:
   *   - batch_number exact match for entries with no EAN,
   *   - brand+name fuzzy with `pg_trgm` once feed cleanliness
   *     justifies the false-positive risk.
   */
  private async findMatches(draft: FeedEntryDraft): Promise<SavedProductMatch[]> {
    if (!draft.ean) return [];
    return this.alerts.findMatchesByEan(draft.ean);
  }
}
