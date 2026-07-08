import { OwnerMetricsAggregatorService } from '../services/owner-metrics-aggregator.service';

/**
 * The aggregator runs many cross-table queries; we mock the
 * underlying `db.execute()` instead of every single SQL. The leads /
 * app-events repos still expose dedicated methods we mock individually.
 *
 * Execute call ordering is deterministic because of Promise.all
 * scheduling: every helper kicks off its first `db.execute()` call
 * synchronously, so the queue is filled in this order:
 *
 *   1. website overview
 *   2. tableExists('tenant_subscriptions')   ← tenantSubsForDay
 *   3. tableExists('tenant_subscriptions')   ← planDistribution
 *   4. tableExists('scan_items')             ← usageForDay (inner Promise.all)
 *   5. tableExists('reports')                ← usageForDay
 *   6. tableExists('ai_usage_log')           ← usageForDay
 *   7. tableExists('tenant_subscriptions')   ← computeMrr
 *
 * Then the deferred follow-ups run in the same order they were awaited:
 *
 *   8. tenantSubsForDay counts SELECT
 *   9. planDistribution SELECT
 *  10. computeMrr SUM SELECT
 */
const buildSvc = () => {
  const execRows: Array<unknown> = [];
  const exec = jest.fn(async () => execRows.shift() ?? []);

  const db = {
    getDb: () => ({ execute: exec }),
  } as unknown as ConstructorParameters<typeof OwnerMetricsAggregatorService>[0];

  const websiteRepo = {} as unknown as ConstructorParameters<
    typeof OwnerMetricsAggregatorService
  >[1];

  const leadsRepo = {
    countCreatedBetween: jest.fn(async () => 3),
    countQualifiedBetween: jest.fn(async () => 2),
    countConvertedBetween: jest.fn(async () => 1),
  } as unknown as ConstructorParameters<typeof OwnerMetricsAggregatorService>[2];

  const appEventsRepo = {
    countDistinctUsersOnDay: jest.fn(async () => 12),
    countDistinctUsersBetween: jest.fn(async () => 50),
  } as unknown as ConstructorParameters<typeof OwnerMetricsAggregatorService>[3];

  const upsertCalls: Array<Record<string, unknown>> = [];
  const metricsRepo = {
    upsert: jest.fn(async (row: Record<string, unknown>) => {
      upsertCalls.push(row);
      return { id: `m${upsertCalls.length}`, ...row };
    }),
  } as unknown as ConstructorParameters<typeof OwnerMetricsAggregatorService>[4];

  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as ConstructorParameters<typeof OwnerMetricsAggregatorService>[5];

  const queue = (rows: unknown[]) => {
    execRows.push(rows);
  };

  return {
    svc: new OwnerMetricsAggregatorService(
      db,
      websiteRepo,
      leadsRepo,
      appEventsRepo,
      metricsRepo,
      logger,
    ),
    upsertCalls,
    queue,
    queueAllTablesMissing: () => {
      queue([
        {
          visitors: 5,
          page_views: 20,
          contact_clicks: 1,
          pricing_views: 3,
          app_download_clicks: 1,
        },
      ]);
      queue([{ exists: null }]);
      queue([{ exists: null }]);
      queue([{ exists: null }]);
      queue([{ exists: null }]);
      queue([{ exists: null }]);
      queue([{ exists: null }]);
    },
  };
};

describe('OwnerMetricsAggregatorService.aggregateForDate', () => {
  it('upserts a metrics row with website + lead counts (other tables missing)', async () => {
    const { svc, upsertCalls, queueAllTablesMissing } = buildSvc();
    queueAllTablesMissing();

    const result = await svc.aggregateForDate(new Date('2026-01-15T12:00:00Z'));
    expect(result.date).toBe('2026-01-15');
    expect(upsertCalls).toHaveLength(1);

    const row = upsertCalls[0];
    expect(row.websiteVisitors).toBe(5);
    expect(row.websitePageViews).toBe(20);
    expect(row.newLeads).toBe(3);
    expect(row.qualifiedLeads).toBe(2);
    expect(row.convertedLeads).toBe(1);
    expect(row.dau).toBe(12);
    expect(row.mau).toBe(50);
    expect(row.activeTenants).toBe(0);
    expect(row.mrr).toBe('0');
  });

  it('is idempotent — second run for same UTC day produces same row contents', async () => {
    const { svc, upsertCalls, queueAllTablesMissing } = buildSvc();
    queueAllTablesMissing();
    queueAllTablesMissing();

    await svc.aggregateForDate(new Date('2026-01-15T00:00:00Z'));
    await svc.aggregateForDate(new Date('2026-01-15T23:59:59Z'));

    expect(upsertCalls).toHaveLength(2);
    expect(upsertCalls[0].websiteVisitors).toBe(upsertCalls[1].websiteVisitors);
    expect((upsertCalls[0].date as Date).toISOString()).toBe(
      (upsertCalls[1].date as Date).toISOString(),
    );
  });

  it('computes MRR from tenant_subscriptions sum when table exists', async () => {
    const { svc, upsertCalls, queue } = buildSvc();
    // 1. website overview
    queue([
      {
        visitors: 0,
        page_views: 0,
        contact_clicks: 0,
        pricing_views: 0,
        app_download_clicks: 0,
      },
    ]);
    // 2-3. tableExists tenants / plans (both present)
    queue([{ exists: 'public.tenant_subscriptions' }]);
    queue([{ exists: 'public.tenant_subscriptions' }]);
    // 4-6. tableExists scan_items / reports / ai_usage_log (missing)
    queue([{ exists: null }]);
    queue([{ exists: null }]);
    queue([{ exists: null }]);
    // 7. tableExists mrr (present)
    queue([{ exists: 'public.tenant_subscriptions' }]);
    // 8. tenant counts SELECT
    queue([
      {
        new_tenants: 1,
        active_tenants: 12,
        trial_tenants: 4,
        paid_tenants: 8,
        cancelled_tenants: 1,
      },
    ]);
    // 9. plan distribution rows
    queue([
      { plan_code: 'starter', count: 5 },
      { plan_code: 'growth', count: 2 },
      { plan_code: 'pro', count: 1 },
    ]);
    // 10. MRR SUM
    queue([{ mrr: '7150.00' }]);

    await svc.aggregateForDate(new Date('2026-02-01T12:00:00Z'));
    const row = upsertCalls[0];
    expect(row.mrr).toBe('7150.00');
    expect(row.activeTenants).toBe(12);
    expect(row.starterCount).toBe(5);
    expect(row.growthCount).toBe(2);
    expect(row.proCount).toBe(1);
  });
});
