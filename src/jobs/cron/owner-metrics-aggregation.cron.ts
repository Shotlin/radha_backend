import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LoggerService } from '@/logging/logger.service';
import { OwnerMetricsAggregatorService } from '@/modules/analytics/services/owner-metrics-aggregator.service';

/**
 * BE-29 — Owner-metrics aggregation cron.
 *
 * Runs daily at 03:00 IST (Asia/Kolkata) — equivalent to 21:30 UTC
 * the previous day. Late enough that yesterday's writes have all
 * landed but early enough that India-morning owner dashboards see
 * fresh KPI numbers.
 *
 * The aggregator is idempotent (upsert on `(date)`), so re-running
 * the cron — manually or after a failed run — produces the same row.
 */
@Injectable()
export class OwnerMetricsAggregationCron {
  private readonly logger = new Logger(OwnerMetricsAggregationCron.name);

  constructor(
    private readonly aggregator: OwnerMetricsAggregatorService,
    private readonly appLogger: LoggerService,
  ) {}

  @Cron('0 3 * * *', { name: 'owner-metrics-aggregation', timeZone: 'Asia/Kolkata' })
  async run(): Promise<void> {
    // We aggregate "yesterday" in Asia/Kolkata terms so dashboards in
    // India read whole-day numbers. The aggregator normalises to UTC
    // midnight internally, so we just walk back one calendar day.
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    this.logger.log(`owner-metrics-aggregation: starting for ${yesterday.toISOString()}`);

    try {
      const result = await this.aggregator.aggregateForDate(yesterday);
      this.appLogger.info('cron.owner-metrics-aggregation.completed', { result });
    } catch (err) {
      this.logger.error('cron.owner-metrics-aggregation.failed', err as Error);
    }
  }

  /** Test hook — invoke without waiting for the cron schedule. */
  async runForDate(date: Date): Promise<unknown> {
    return this.aggregator.aggregateForDate(date);
  }
}
