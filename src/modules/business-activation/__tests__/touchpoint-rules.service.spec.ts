import { TouchpointCounterService, CountSnapshot } from '../services/touchpoint-counter.service';
import { TouchpointRulesService } from '../services/touchpoint-rules.service';

const USER_ID = '00000000-0000-0000-0000-000000000001';

const buildSvc = (snapshot: Partial<CountSnapshot> = {}) => {
  const defaults: CountSnapshot = {
    totalScans: 0,
    scansThisWeek: 0,
    savedProducts: 0,
    ...snapshot,
  };

  const counter = {
    snapshot: jest.fn().mockResolvedValue(defaults),
  } as unknown as TouchpointCounterService;

  const svc = new TouchpointRulesService(counter);
  return { svc, counter };
};

describe('TouchpointRulesService', () => {
  describe('evaluate', () => {
    it('returns banner5Scans=false when user has fewer than 5 scans', async () => {
      const { svc } = buildSvc({ totalScans: 4 });
      const result = await svc.evaluate(USER_ID);
      expect(result.banner5Scans).toBe(false);
    });

    it('returns banner5Scans=true when user has exactly 5 scans', async () => {
      const { svc } = buildSvc({ totalScans: 5 });
      const result = await svc.evaluate(USER_ID);
      expect(result.banner5Scans).toBe(true);
    });

    it('returns banner5Scans=true when user has more than 5 scans', async () => {
      const { svc } = buildSvc({ totalScans: 100 });
      const result = await svc.evaluate(USER_ID);
      expect(result.banner5Scans).toBe(true);
    });

    it('always returns homeCard=true regardless of scan count', async () => {
      const { svc } = buildSvc({ totalScans: 0 });
      const result = await svc.evaluate(USER_ID);
      expect(result.homeCard).toBe(true);
    });

    it('returns heavyScanWeekly=false when scans this week < 50', async () => {
      const { svc } = buildSvc({ scansThisWeek: 49 });
      const result = await svc.evaluate(USER_ID);
      expect(result.heavyScanWeekly).toBe(false);
    });

    it('returns heavyScanWeekly=true when scans this week >= 50', async () => {
      const { svc } = buildSvc({ scansThisWeek: 50 });
      const result = await svc.evaluate(USER_ID);
      expect(result.heavyScanWeekly).toBe(true);
    });

    it('returns heavyScanWeekly=true when scans this week > 50', async () => {
      const { svc } = buildSvc({ scansThisWeek: 200 });
      const result = await svc.evaluate(USER_ID);
      expect(result.heavyScanWeekly).toBe(true);
    });

    it('always returns profileCta=true regardless of scan count', async () => {
      const { svc } = buildSvc({ totalScans: 0, savedProducts: 0 });
      const result = await svc.evaluate(USER_ID);
      expect(result.profileCta).toBe(true);
    });

    it('returns saveLimitPrompt=false when saved products < 5', async () => {
      const { svc } = buildSvc({ savedProducts: 4 });
      const result = await svc.evaluate(USER_ID);
      expect(result.saveLimitPrompt).toBe(false);
    });

    it('returns saveLimitPrompt=true when saved products >= 5 (at limit)', async () => {
      const { svc } = buildSvc({ savedProducts: 5 });
      const result = await svc.evaluate(USER_ID);
      expect(result.saveLimitPrompt).toBe(true);
    });

    it('returns saveLimitPrompt=true when saved products > 5 (past limit)', async () => {
      const { svc } = buildSvc({ savedProducts: 10 });
      const result = await svc.evaluate(USER_ID);
      expect(result.saveLimitPrompt).toBe(true);
    });

    it('calls counter.snapshot with the correct userId', async () => {
      const { svc, counter } = buildSvc();
      await svc.evaluate(USER_ID);
      expect(counter.snapshot).toHaveBeenCalledWith(USER_ID);
    });

    it('all touchpoints active for a heavy user', async () => {
      const { svc } = buildSvc({ totalScans: 100, scansThisWeek: 60, savedProducts: 10 });
      const result = await svc.evaluate(USER_ID);
      expect(result.banner5Scans).toBe(true);
      expect(result.homeCard).toBe(true);
      expect(result.heavyScanWeekly).toBe(true);
      expect(result.profileCta).toBe(true);
      expect(result.saveLimitPrompt).toBe(true);
    });

    it('minimal touchpoints for a new user with no scans', async () => {
      const { svc } = buildSvc({ totalScans: 0, scansThisWeek: 0, savedProducts: 0 });
      const result = await svc.evaluate(USER_ID);
      expect(result.banner5Scans).toBe(false);
      expect(result.homeCard).toBe(true);
      expect(result.heavyScanWeekly).toBe(false);
      expect(result.profileCta).toBe(true);
      expect(result.saveLimitPrompt).toBe(false);
    });
  });
});
