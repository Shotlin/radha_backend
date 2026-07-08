import { FunnelService } from '../services/funnel.service';

const buildSvc = (
  websiteCounts = { visitors: 1000, pricingViewers: 300, inquirers: 50, downloaders: 20 },
  leadStats = {
    totalLeads: 50,
    contacted: 30,
    qualified: 20,
    converted: 10,
    lost: 5,
    spam: 2,
  },
) => {
  const websiteRepo = {
    getFunnelCounts: jest.fn(async () => websiteCounts),
  } as unknown as ConstructorParameters<typeof FunnelService>[0];
  const leadsRepo = {
    getConversionStats: jest.fn(async () => leadStats),
  } as unknown as ConstructorParameters<typeof FunnelService>[1];
  return {
    svc: new FunnelService(websiteRepo, leadsRepo),
    websiteRepo: websiteRepo as unknown as Record<string, jest.Mock>,
    leadsRepo: leadsRepo as unknown as Record<string, jest.Mock>,
  };
};

describe('FunnelService.getFullFunnel', () => {
  it('joins website + leads counts into a 4-step funnel', async () => {
    const { svc } = buildSvc();
    const f = await svc.getFullFunnel({
      from: new Date('2026-01-01'),
      to: new Date('2026-01-31'),
    });
    expect(f.steps).toHaveLength(4);
    expect(f.steps[0].name).toBe('Visitors');
    expect(f.steps[3].name).toBe('Converted');
    expect(f.totalVisitors).toBe(1000);
    expect(f.totalConversions).toBe(10);
    expect(f.overallConversion).toBe(1); // 10 / 1000 = 1%
  });

  it('uses lead totalLeads when website inquirers count is lower', async () => {
    const { svc } = buildSvc(
      { visitors: 500, pricingViewers: 200, inquirers: 5, downloaders: 3 },
      { totalLeads: 50, contacted: 30, qualified: 10, converted: 4, lost: 2, spam: 1 },
    );
    const f = await svc.getFullFunnel({ from: new Date(), to: new Date() });
    expect(f.steps[2].count).toBe(50);
  });

  it('handles zero traffic without crashing', async () => {
    const { svc } = buildSvc(
      { visitors: 0, pricingViewers: 0, inquirers: 0, downloaders: 0 },
      { totalLeads: 0, contacted: 0, qualified: 0, converted: 0, lost: 0, spam: 0 },
    );
    const f = await svc.getFullFunnel({ from: new Date(), to: new Date() });
    expect(f.overallConversion).toBe(0);
    for (const step of f.steps.slice(1)) {
      expect(step.conversionRate).toBe(0);
    }
  });
});
