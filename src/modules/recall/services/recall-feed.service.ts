import { Inject, Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import {
  ERROR_TRACKING_SERVICE,
  IErrorTrackingService,
} from '@/observability/error-tracking.types';

import { RecallFeedEntriesRepository } from '../repositories/recall-feed-entries.repository';
import { FeedEntryDraft, IRecallFeedAdapter, RECALL_FEED_ADAPTERS } from '../types/recall.types';

import type { RecallFeedEntryRow } from '@/db/schema/recall';

/**
 * BE-39 — Owns interaction with upstream recall feeds.
 *
 *   - `fetchAll()` loops every registered adapter, applies a per-adapter
 *     retry-with-exponential-backoff (max 3 attempts: 0/500/1500ms) and
 *     swallows hard failures so a single broken publisher doesn't
 *     block the others. A full failure of one source is sent to
 *     Sentry as a captured warning so the on-call sees it without
 *     waking up to a 4am page.
 *
 *   - `persistFeedEntry()` is idempotent on the natural-key tuple
 *     `(source, ean, batch_number, recalled_at, reason)`. The first
 *     fetch inserts; replays return the existing row without writing.
 *
 * The matching logic and alert creation live in `RecallSweepService`
 * — this file is the thin "fetch + persist" half of the job.
 */
@Injectable()
export class RecallFeedService {
  private static readonly RETRY_DELAYS_MS = [0, 500, 1500];

  constructor(
    private readonly entries: RecallFeedEntriesRepository,
    private readonly logger: LoggerService,
    @Inject(ERROR_TRACKING_SERVICE)
    private readonly errorTracking: IErrorTrackingService,
    @Inject(RECALL_FEED_ADAPTERS)
    private readonly adapters: IRecallFeedAdapter[],
  ) {}

  /**
   * Fetch every registered feed. Per-source failures are isolated;
   * the returned `failedSources` lets the sweep job decide whether
   * to escalate to Sentry as a fatal job failure.
   */
  async fetchAll(): Promise<{
    entries: FeedEntryDraft[];
    failedSources: string[];
  }> {
    const entries: FeedEntryDraft[] = [];
    const failedSources: string[] = [];

    for (const adapter of this.adapters) {
      try {
        const drafts = await this.fetchWithRetry(adapter);
        entries.push(...drafts);
        this.logger.info('recall.feed.fetched', {
          source: adapter.source,
          count: drafts.length,
        });
      } catch (err) {
        failedSources.push(adapter.source);
        this.logger.error('recall.feed.fetch.failed', {
          source: adapter.source,
          error: { name: (err as Error).name, message: (err as Error).message },
        });
        this.errorTracking.captureException(err as Error, {
          module: 'recall',
          metadata: { source: adapter.source, phase: 'fetch' },
        });
      }
    }

    return { entries, failedSources };
  }

  /**
   * Insert if-not-exists. Returns `{ row, created }` so the sweep
   * service can count duplicates (helpful for dashboard SLOs).
   */
  async persistFeedEntry(
    draft: FeedEntryDraft,
  ): Promise<{ row: RecallFeedEntryRow; created: boolean }> {
    const existing = await this.entries.findExisting(
      draft.source,
      draft.ean,
      draft.batchNumber,
      draft.recalledAt,
      draft.reason,
    );
    if (existing) {
      return { row: existing, created: false };
    }
    const row = await this.entries.create({
      source: draft.source,
      ean: draft.ean,
      brand: draft.brand,
      productName: draft.productName,
      batchNumber: draft.batchNumber,
      reason: draft.reason,
      recalledAt: draft.recalledAt,
      raw: draft.raw,
    });
    return { row, created: true };
  }

  /** Internal — exponential-backoff retry around `adapter.fetch()`. */
  private async fetchWithRetry(adapter: IRecallFeedAdapter): Promise<FeedEntryDraft[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < RecallFeedService.RETRY_DELAYS_MS.length; attempt += 1) {
      const delay = RecallFeedService.RETRY_DELAYS_MS[attempt];
      if (delay > 0) await this.sleep(delay);
      try {
        return await adapter.fetch();
      } catch (err) {
        lastError = err;
        this.logger.warn('recall.feed.fetch.attempt-failed', {
          source: adapter.source,
          attempt: attempt + 1,
          error: { name: (err as Error).name, message: (err as Error).message },
        });
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`recall.feed.${adapter.source}.exhausted-retries`);
  }

  /** Test seam — overridden in unit tests to advance fake timers. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
