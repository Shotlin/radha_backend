import { OwnerMetricsAggregationCron } from '@/jobs/cron/owner-metrics-aggregation.cron';

describe('OwnerMetricsAggregationCron', () => {
  it('registers a `run` method (decorated with @Cron at compile time)', () => {
    expect(typeof OwnerMetricsAggregationCron.prototype.run).toBe('function');
  });

  it('runs the aggregator and forwards the result to the application logger', async () => {
    const aggregator = {
      aggregateForDate: jest.fn(async () => ({
        date: '2026-01-15',
        mrr: '0',
        dau: 0,
      })),
    } as unknown as ConstructorParameters<typeof OwnerMetricsAggregationCron>[0];
    const appLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as ConstructorParameters<typeof OwnerMetricsAggregationCron>[1];
    const cron = new OwnerMetricsAggregationCron(aggregator, appLogger);

    await cron.run();
    expect(
      (aggregator as unknown as { aggregateForDate: jest.Mock }).aggregateForDate,
    ).toHaveBeenCalledTimes(1);
    expect((appLogger as unknown as { info: jest.Mock }).info).toHaveBeenCalledWith(
      'cron.owner-metrics-aggregation.completed',
      expect.objectContaining({ result: expect.any(Object) }),
    );
  });

  it('swallows aggregator errors so the scheduler keeps running', async () => {
    const aggregator = {
      aggregateForDate: jest.fn(async () => {
        throw new Error('db boom');
      }),
    } as unknown as ConstructorParameters<typeof OwnerMetricsAggregationCron>[0];
    const appLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as ConstructorParameters<typeof OwnerMetricsAggregationCron>[1];
    const cron = new OwnerMetricsAggregationCron(aggregator, appLogger);
    await expect(cron.run()).resolves.toBeUndefined();
  });

  it('runForDate exposes a manual trigger for tests + ops re-runs', async () => {
    const aggregator = {
      aggregateForDate: jest.fn(async (d: Date) => ({
        date: d.toISOString().slice(0, 10),
        mrr: '0',
        dau: 0,
      })),
    } as unknown as ConstructorParameters<typeof OwnerMetricsAggregationCron>[0];
    const appLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as ConstructorParameters<typeof OwnerMetricsAggregationCron>[1];
    const cron = new OwnerMetricsAggregationCron(aggregator, appLogger);
    const out = (await cron.runForDate(new Date('2026-01-15T00:00:00Z'))) as { date: string };
    expect(out.date).toBe('2026-01-15');
  });
});
