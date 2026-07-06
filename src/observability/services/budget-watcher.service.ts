import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LoggerService } from '@/logging/logger.service';

/**
 * Sentry free-tier budget watcher (BE-48).
 *
 * Tracks how many events the in-process Sentry SDK has captured this
 * calendar month and warns when usage crosses 85% of the 5,000-event
 * free-tier ceiling (4,250 events). The check runs daily at 09:00
 * IST; cheap to run and gives ops a full day to react before the
 * quota actually trips.
 *
 *   - Counter is in-memory: a single API process tracks its own
 *     events. With multiple processes, each warns independently —
 *     intentional, because the alarm is "we're getting close to
 *     burning the free tier" and any single chatty process is enough
 *     to act on.
 *   - The counter rolls over on calendar-month change (UTC). Workers
 *     `record()` once per Sentry capture; the cron compares the
 *     current month's count to `MONTHLY_THRESHOLD`.
 *   - When tripped, we log a warning AND emit a structured
 *     `analytics.sentry_budget_warning` event so downstream analytics
 *     consumers (BE-31 owner dashboard, BE-50 webhooks) can react.
 *     The same trip will not warn again until the next calendar
 *     month, to avoid alert fatigue.
 */

/** 85% of the Sentry developer free tier (5,000 events / month). */
export const MONTHLY_THRESHOLD = 4250;

/** Effective monthly cap for context only; not used in the comparison. */
export const FREE_TIER_CEILING = 5000;

@Injectable()
export class BudgetWatcherService {
  private monthKey: string;
  private currentMonthCount = 0;
  private alreadyWarnedThisMonth = false;

  constructor(private readonly logger: LoggerService) {
    this.monthKey = BudgetWatcherService.computeMonthKey(new Date());
  }

  /**
   * Increment the captured-event counter. Called from the Sentry
   * `beforeSend` hook (`sentry.bootstrap.ts`) once per delivered event.
   */
  record(now: Date = new Date()): void {
    this.rolloverIfMonthChanged(now);
    this.currentMonthCount += 1;
  }

  /** Returns the captured-event count for the current calendar month. */
  getCurrentCount(now: Date = new Date()): number {
    this.rolloverIfMonthChanged(now);
    return this.currentMonthCount;
  }

  /** Test/diagnostic hook — exposed so unit tests can simulate state. */
  setCountForTesting(count: number, now: Date = new Date()): void {
    this.rolloverIfMonthChanged(now);
    this.currentMonthCount = count;
  }

  /**
   * Daily Sentry-budget check at 09:00 IST.
   *
   * Cron registered here so the scheduler entrypoint picks it up
   * automatically when `ObservabilityModule` is imported by AppModule.
   */
  @Cron('0 9 * * *', { name: 'sentry-budget-watcher', timeZone: 'Asia/Kolkata' })
  checkBudget(now: Date = new Date()): void {
    this.rolloverIfMonthChanged(now);

    if (this.currentMonthCount <= MONTHLY_THRESHOLD) return;
    if (this.alreadyWarnedThisMonth) return;

    const usagePercent = Math.round((this.currentMonthCount / FREE_TIER_CEILING) * 100);

    this.logger.warn('sentry.budget.threshold_exceeded', {
      currentCount: this.currentMonthCount,
      threshold: MONTHLY_THRESHOLD,
      ceiling: FREE_TIER_CEILING,
      usagePercent,
      monthKey: this.monthKey,
    });

    this.logger.info('analytics.sentry_budget_warning', {
      analytics: true,
      event: 'sentry_budget_warning',
      currentCount: this.currentMonthCount,
      threshold: MONTHLY_THRESHOLD,
      ceiling: FREE_TIER_CEILING,
      usagePercent,
      monthKey: this.monthKey,
    });

    this.alreadyWarnedThisMonth = true;
  }

  /**
   * Resets the counter when the calendar month rolls over.
   * Idempotent — called on every public method to keep the in-memory
   * state coherent without relying on a separate scheduler tick.
   */
  private rolloverIfMonthChanged(now: Date): void {
    const next = BudgetWatcherService.computeMonthKey(now);
    if (next !== this.monthKey) {
      this.monthKey = next;
      this.currentMonthCount = 0;
      this.alreadyWarnedThisMonth = false;
    }
  }

  private static computeMonthKey(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }
}
