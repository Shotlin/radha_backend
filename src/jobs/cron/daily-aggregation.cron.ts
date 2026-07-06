import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LoggerService } from '@/logging/logger.service';
import { MetricsAggregatorService } from '@/modules/reports/services/metrics-aggregator.service';

/**
 * BE-24 — Daily metrics aggregation cron.
 *
 * Runs at 01:00 UTC every day. Aggregates yesterday's per-store metrics
 * (scans, expiry, tasks, alerts) into the `daily_store_metrics` table
 * so dashboards (BE-20) can read pre-aggregated rows in O(stores) and
 * not O(events).
 *
 * Idempotent: `MetricsAggregatorService.aggregateForDate` upserts on
 * `(storeId, date)`, so re-running for the same day overwrites cleanly.
 *
 * Schedule choice: 01:00 UTC = 06:30 IST. Late enough that all
 * scan/expiry events for the previous UTC day have hit the DB but
 * early enough that India-morning dashboards see fresh numbers.
 */
@Injectable()
export class DailyAggregationCron {
  private readonly logger = new Logger(DailyAggregationCron.name);

  constructor(
    private readonly aggregator: MetricsAggregatorService,
    private readonly appLogger: LoggerService,
  ) {}

  @Cron('0 1 * * *', { name: 'daily-aggregation', timeZone: 'UTC' })
  async run(): Promise<void> {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0);

    this.logger.log(`daily-aggregation: starting for ${yesterday.toISOString()}`);

    try {
      const result = await this.aggregator.aggregateForDate(yesterday);
      this.appLogger.info('cron.daily-aggregation.completed', {
        date: yesterday.toISOString().slice(0, 10),
        result,
      });
    } catch (err) {
      this.logger.error('cron.daily-aggregation.failed', err as Error);
    }
  }
}
