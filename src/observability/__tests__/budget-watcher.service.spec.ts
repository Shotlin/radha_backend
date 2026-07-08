import { LoggerService } from '@/logging/logger.service';

import {
  BudgetWatcherService,
  FREE_TIER_CEILING,
  MONTHLY_THRESHOLD,
} from '../services/budget-watcher.service';

/**
 * BE-48 Budget Watcher coverage.
 *
 * The service is instantiated directly with a stub logger to keep
 * the harness deterministic — the cron decorator only registers a
 * job; we invoke `checkBudget()` ourselves to simulate the trigger
 * and inject explicit `now` arguments to exercise month rollover.
 */
describe('BudgetWatcherService', () => {
  let logger: { warn: jest.Mock; info: jest.Mock };
  let service: BudgetWatcherService;

  beforeEach(() => {
    logger = { warn: jest.fn(), info: jest.fn() };
    service = new BudgetWatcherService(logger as unknown as LoggerService);
  });

  it('record() increments the in-memory monthly counter', () => {
    expect(service.getCurrentCount()).toBe(0);
    service.record();
    service.record();
    service.record();
    expect(service.getCurrentCount()).toBe(3);
  });

  it('checkBudget() does NOT warn when count is below the 85% threshold', () => {
    service.setCountForTesting(MONTHLY_THRESHOLD); // exactly at threshold ⇒ no warn
    service.checkBudget();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(
      'analytics.sentry_budget_warning',
      expect.anything(),
    );
  });

  it('checkBudget() warns and emits an analytics event when count exceeds the threshold', () => {
    service.setCountForTesting(MONTHLY_THRESHOLD + 1);
    service.checkBudget();

    expect(logger.warn).toHaveBeenCalledWith(
      'sentry.budget.threshold_exceeded',
      expect.objectContaining({
        currentCount: MONTHLY_THRESHOLD + 1,
        threshold: MONTHLY_THRESHOLD,
        ceiling: FREE_TIER_CEILING,
      }),
    );

    expect(logger.info).toHaveBeenCalledWith(
      'analytics.sentry_budget_warning',
      expect.objectContaining({
        analytics: true,
        event: 'sentry_budget_warning',
        currentCount: MONTHLY_THRESHOLD + 1,
      }),
    );
  });

  it('warns only once per calendar month (no alert fatigue) until rollover resets state', () => {
    const january = new Date(Date.UTC(2025, 0, 15)); // Jan 15
    const february = new Date(Date.UTC(2025, 1, 1)); //  Feb 1

    service.setCountForTesting(MONTHLY_THRESHOLD + 100, january);
    service.checkBudget(january);
    service.checkBudget(january); // second call same month — must not re-warn

    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Month rolls over → counter resets, so the threshold is no
    // longer breached and `checkBudget` is silent again.
    expect(service.getCurrentCount(february)).toBe(0);
    service.checkBudget(february);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // …and once we cross the threshold in the new month, it warns
    // exactly one more time.
    service.setCountForTesting(MONTHLY_THRESHOLD + 1, february);
    service.checkBudget(february);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
