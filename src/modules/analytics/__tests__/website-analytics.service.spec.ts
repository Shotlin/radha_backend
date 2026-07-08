import { WebsiteAnalyticsService } from '../services/website-analytics.service';
import { MIN_SALT_LENGTH } from '../utils/analytics-hash.util';

const VALID_SALT = 'a'.repeat(MIN_SALT_LENGTH);

const buildSvc = (overrides: Partial<Record<string, unknown>> = {}) => {
  const created: Array<Record<string, unknown>> = [];
  const repo = {
    create: jest.fn(async (data: Record<string, unknown>) => {
      created.push(data);
      return { id: `we-${created.length}`, ...data };
    }),
    getOverview: jest.fn(async () => ({ totalViews: 100, uniqueVisitors: 70, sessions: 80 })),
    getConversionsByType: jest.fn(async () => ({
      contact_click: 5,
      demo_click: 2,
      app_download_click: 1,
      pricing_view: 20,
      form_submit: 3,
    })),
    getTopPages: jest.fn(async () => [{ page: '/pricing', views: 30, uniqueVisitors: 20 }]),
    getByCountry: jest.fn(async () => [{ country: 'IN', visitors: 60 }]),
    getByDevice: jest.fn(async () => [{ device: 'mobile', count: 40 }]),
    getTrafficSources: jest.fn(async () => [{ source: 'google', visitors: 30 }]),
    getFunnelCounts: jest.fn(async () => ({
      visitors: 100,
      pricingViewers: 40,
      inquirers: 10,
      downloaders: 5,
    })),
    countByVisitorHash: jest.fn(async () => 0),
    ...(overrides.repo ?? {}),
  } as never;
  const config = { rateLimit: { windowMs: 60_000, max: 100 } } as never;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;
  return {
    svc: new WebsiteAnalyticsService(repo, config, logger),
    repo: repo as unknown as Record<string, jest.Mock>,
    created,
  };
};

describe('WebsiteAnalyticsService.trackEvent', () => {
  const ORIGINAL_ENV = process.env.ANALYTICS_HASH_SALT;
  beforeEach(() => {
    process.env.ANALYTICS_HASH_SALT = VALID_SALT;
  });
  afterEach(() => {
    process.env.ANALYTICS_HASH_SALT = ORIGINAL_ENV;
  });

  it('persists a page_view event with hashed visitor / session ids', async () => {
    const { svc, created } = buildSvc();
    await svc.trackEvent({
      type: 'page_view',
      page: '/home',
      sessionId: 'sess-1',
      visitorId: 'visitor-1',
    });
    expect(created).toHaveLength(1);
    const row = created[0];
    expect(row.type).toBe('page_view');
    expect(row.page).toBe('/home');
    expect(typeof row.visitorIdHash).toBe('string');
    expect((row.visitorIdHash as string).length).toBe(64);
    expect(row.visitorIdHash).not.toBe('visitor-1');
    expect(row.sessionId).not.toBe('sess-1');
  });

  it('redacts PII from metadata before insert', async () => {
    const { svc, created } = buildSvc();
    await svc.trackEvent({
      type: 'form_submit',
      sessionId: 's',
      metadata: {
        userMobile: '9876543210',
        note: 'PAN ABCDE1234F is bad',
      },
    });
    const row = created[0];
    expect(row.metadata).toBeDefined();
    const m = row.metadata as Record<string, unknown>;
    expect(m.userMobile).toBe('[REDACTED]');
    expect(m.note).toContain('[REDACTED]');
    expect(m.note).not.toContain('ABCDE1234F');
  });

  it('records a button_click event without a page', async () => {
    const { svc, created } = buildSvc();
    await svc.trackEvent({ type: 'button_click', sessionId: 's' });
    expect(created[0].type).toBe('button_click');
  });

  it('uppercases country code and discards extra characters', async () => {
    const { svc, created } = buildSvc();
    await svc.trackEvent({ type: 'page_view', sessionId: 's', country: 'in' });
    expect(created[0].country).toBe('IN');
  });

  it('throws when salt is missing — fail loud per privacy spec', async () => {
    process.env.ANALYTICS_HASH_SALT = '';
    const { svc } = buildSvc();
    await expect(svc.trackEvent({ type: 'page_view', sessionId: 's' })).rejects.toThrow(
      /ANALYTICS_HASH_SALT/,
    );
  });
});

describe('WebsiteAnalyticsService.getStats', () => {
  it('aggregates conversions and shapes the response correctly', async () => {
    process.env.ANALYTICS_HASH_SALT = VALID_SALT;
    const { svc } = buildSvc();
    const stats = await svc.getStats({
      from: new Date('2026-01-01'),
      to: new Date('2026-01-31'),
    });
    expect(stats.uniqueVisitors).toBe(70);
    expect(stats.pageViews).toBe(100);
    expect(stats.conversions.demoRequests).toBe(2);
    expect(stats.conversions.appDownloadClicks).toBe(1);
    expect(stats.conversions.contactFormSubmissions).toBe(8);
    expect(stats.byPage[0].page).toBe('/pricing');
  });
});

describe('WebsiteAnalyticsService.getFunnel', () => {
  it('computes accurate conversion + dropoff rates', async () => {
    process.env.ANALYTICS_HASH_SALT = VALID_SALT;
    const { svc } = buildSvc();
    const f = await svc.getFunnel({
      from: new Date('2026-01-01'),
      to: new Date('2026-01-31'),
    });
    expect(f.totalVisitors).toBe(100);
    expect(f.totalConversions).toBe(5);
    expect(f.overallConversion).toBe(5);
    expect(f.steps[1].count).toBe(40);
    expect(f.steps[1].conversionRate).toBe(40);
    expect(f.steps[1].dropoffRate).toBe(60);
    expect(f.steps[3].conversionRate).toBe(50);
  });

  it('returns zeroed rates without dividing by zero', async () => {
    process.env.ANALYTICS_HASH_SALT = VALID_SALT;
    const { svc } = buildSvc({
      repo: {
        getFunnelCounts: jest.fn(async () => ({
          visitors: 0,
          pricingViewers: 0,
          inquirers: 0,
          downloaders: 0,
        })),
      },
    });
    const f = await svc.getFunnel({ from: new Date(), to: new Date() });
    for (const step of f.steps.slice(1)) {
      expect(step.conversionRate).toBe(0);
      expect(step.dropoffRate).toBe(0);
    }
    expect(f.overallConversion).toBe(0);
  });
});
