import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import { SearchRepository } from '../repositories/search.repository';
import type { SearchAnalyticsEvent } from '../types/search.types';

/**
 * BE-14 — search analytics.
 *
 * Decoupled from the search service so:
 *   1. The hot search path doesn't await analytics writes (fire and
 *      forget — see `track`).
 *   2. BE-25 (reports) can swap in a different sink (Kafka, S3 logs)
 *      without touching the search code path.
 *
 * Failures in analytics never bubble up — they're logged and dropped.
 * Search SLOs (Req 39: 500 ms P95) take precedence over telemetry.
 */
@Injectable()
export class SearchAnalyticsService {
  constructor(
    private readonly searchRepo: SearchRepository,
    private readonly logger: LoggerService,
  ) {}

  /** Fire-and-forget. Caller does not await. */
  track(event: SearchAnalyticsEvent): void {
    void this.persist(event);
  }

  /** Awaitable variant for tests. */
  async persist(event: SearchAnalyticsEvent): Promise<void> {
    try {
      await this.searchRepo.logSearch({
        tenantId: event.tenantId,
        userId: event.userId,
        queryText: event.query,
        resultCount: event.resultCount,
        durationMs: event.durationMs,
        source: event.source ?? 'search',
      });
    } catch (err) {
      this.logger.warn('search.analytics.failed', {
        error: { name: (err as Error).name, message: (err as Error).message },
      });
    }
  }
}
