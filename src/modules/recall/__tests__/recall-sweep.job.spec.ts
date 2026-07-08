import { LoggerService } from '@/logging/logger.service';
import { IErrorTrackingService } from '@/observability/error-tracking.types';

import { RecallSweepJob } from '../jobs/recall-sweep.job';
import { RecallSweepService } from '../services/recall-sweep.service';
import type { SweepReport } from '../types/recall.types';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  }) as unknown as LoggerService;

const buildErrorTracking = (): IErrorTrackingService =>
  ({
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    setUser: jest.fn(),
    clearUser: jest.fn(),
    addBreadcrumb: jest.fn(),
    setTag: jest.fn(),
    setContext: jest.fn(),
  }) as unknown as IErrorTrackingService;

const okReport = (overrides: Partial<SweepReport> = {}): SweepReport => ({
  fetched: 5,
  persisted: 3,
  duplicates: 2,
  alertsCreated: 1,
  notificationsSent: 1,
  failedSources: [],
  durationMs: 42,
  ...overrides,
});

describe('RecallSweepJob', () => {
  it('runs the sweep and logs the result on success', async () => {
    const sweep = {
      runSweep: jest.fn().mockResolvedValue(okReport()),
    } as unknown as RecallSweepService;
    const errorTracking = buildErrorTracking();
    const job = new RecallSweepJob(sweep, buildLogger(), errorTracking);

    await job.runDailySweep();
    expect(sweep.runSweep).toHaveBeenCalledTimes(1);
    expect(errorTracking.captureException).not.toHaveBeenCalled();
    expect(errorTracking.captureMessage).not.toHaveBeenCalled();
  });

  it('escalates a full failure to Sentry with severity=error', async () => {
    const sweep = {
      runSweep: jest.fn().mockResolvedValue(
        okReport({
          fetched: 0,
          persisted: 0,
          alertsCreated: 0,
          notificationsSent: 0,
          failedSources: ['fssai'],
        }),
      ),
    } as unknown as RecallSweepService;
    const errorTracking = buildErrorTracking();
    const job = new RecallSweepJob(sweep, buildLogger(), errorTracking);

    await job.runDailySweep();
    expect(errorTracking.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('full-failure'),
      'error',
      expect.objectContaining({
        module: 'recall',
        metadata: expect.objectContaining({ failedSources: ['fssai'] }),
      }),
    );
  });

  it('captures unhandled exceptions and does not propagate', async () => {
    const sweep = {
      runSweep: jest.fn().mockRejectedValue(new Error('catastrophic')),
    } as unknown as RecallSweepService;
    const errorTracking = buildErrorTracking();
    const job = new RecallSweepJob(sweep, buildLogger(), errorTracking);

    await expect(job.runDailySweep()).resolves.toBeUndefined();
    expect(errorTracking.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ module: 'recall' }),
    );
  });
});
