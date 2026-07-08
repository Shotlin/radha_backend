import { AppAnalyticsService } from '../services/app-analytics.service';

const buildSvc = () => {
  const created: Array<Record<string, unknown>> = [];
  const repo = {
    create: jest.fn(async (data: Record<string, unknown>) => {
      created.push(data);
      return { id: `e-${created.length}`, ...data };
    }),
    insertMany: jest.fn(async (rows: Array<Record<string, unknown>>) => {
      for (const r of rows) created.push(r);
      return rows.length;
    }),
    getUserActivity: jest.fn(async () => ({
      totalEvents: 5,
      activeDays: 3,
      byType: {
        screen_view: 4,
        feature_use: 1,
        error: 0,
        crash: 0,
        performance: 0,
      },
      topActions: [{ category: 'scan', action: 'submit', count: 2 }],
    })),
    getTenantActivity: jest.fn(async () => ({
      totalEvents: 100,
      uniqueUsers: 12,
      byType: {
        screen_view: 80,
        feature_use: 15,
        error: 3,
        crash: 1,
        performance: 1,
      },
    })),
  } as unknown as ConstructorParameters<typeof AppAnalyticsService>[0];
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as ConstructorParameters<typeof AppAnalyticsService>[1];
  return {
    svc: new AppAnalyticsService(repo, logger),
    repo: repo as unknown as Record<string, jest.Mock>,
    created,
  };
};

const baseInput = {
  eventType: 'screen_view' as const,
  category: 'home',
  action: 'view',
};

describe('AppAnalyticsService.trackEvent — tenant isolation', () => {
  it('throws when tenantId is empty (cannot leak events into shared bucket)', async () => {
    const { svc } = buildSvc();
    await expect(svc.trackEvent(baseInput, 'u1', '')).rejects.toThrow(/tenantId/);
  });

  it('persists event with tenant + user from caller, never from input', async () => {
    const { svc, created } = buildSvc();
    await svc.trackEvent(baseInput, 'user-1', 'tenant-A');
    expect(created[0].tenantId).toBe('tenant-A');
    expect(created[0].userId).toBe('user-1');
  });

  it('redacts PII from metadata', async () => {
    const { svc, created } = buildSvc();
    await svc.trackEvent(
      {
        ...baseInput,
        metadata: { ownerEmail: 'leak@bad.com', mobile: '9876543210' },
      },
      'user-1',
      'tenant-A',
    );
    const m = created[0].metadata as Record<string, unknown>;
    expect(m.ownerEmail).toBe('[REDACTED]');
    expect(m.mobile).toBe('[REDACTED]');
  });

  it('serializes numeric value as string for decimal column', async () => {
    const { svc, created } = buildSvc();
    await svc.trackEvent({ ...baseInput, value: 123.45 }, 'u', 't');
    expect(created[0].value).toBe('123.45');
  });
});

describe('AppAnalyticsService.trackBatch', () => {
  it('rejects empty batch (returns 0 accepted)', async () => {
    const { svc } = buildSvc();
    const out = await svc.trackBatch([], 'u', 't');
    expect(out).toEqual({ accepted: 0 });
  });

  it('persists multiple events in one insertMany', async () => {
    const { svc, repo, created } = buildSvc();
    await svc.trackBatch(
      [baseInput, { ...baseInput, action: 'tap' }, { ...baseInput, action: 'scroll' }],
      'u',
      't',
    );
    expect(repo.insertMany).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(3);
  });
});

describe('AppAnalyticsService.getUserActivity', () => {
  it('returns shaped activity for a user within tenant scope', async () => {
    const { svc, repo } = buildSvc();
    const out = await svc.getUserActivity('user-1', 'tenant-A', {
      from: new Date('2026-01-01'),
      to: new Date('2026-01-31'),
    });
    expect(out.userId).toBe('user-1');
    expect(out.totalEvents).toBe(5);
    expect(repo.getUserActivity).toHaveBeenCalledWith(
      'user-1',
      'tenant-A',
      expect.any(Date),
      expect.any(Date),
    );
  });
});
