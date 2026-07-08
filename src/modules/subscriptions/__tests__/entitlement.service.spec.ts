import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { DbService } from '@/db/db.service';

import { PlanEntitlementsRepository } from '../repositories/plan-entitlements.repository';
import { SubscriptionsRepository } from '../repositories/subscriptions.repository';
import { EntitlementService } from '../services/entitlement.service';
import type { Feature, TenantSubscription } from '../types/subscription.types';

const TENANT = '00000000-0000-0000-0000-000000000aaa';
const PLAN_ID = '00000000-0000-0000-0000-000000000bbb';

const baseSub = (over: Partial<TenantSubscription> = {}): TenantSubscription =>
  ({
    id: 'sub-1',
    tenantId: TENANT,
    planId: PLAN_ID,
    planCode: 'starter',
    status: 'active',
    trialStartedAt: null,
    trialEndsAt: null,
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    cancelledAt: null,
    cancellationReason: null,
    monthlyAmount: '49',
    nextBillingDate: null,
    paymentMethod: null,
    lastPaymentAt: null,
    failedPaymentAttempts: 0,
    pendingPlanId: null,
    pendingPlanCode: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    updatedBy: null,
    deletedBy: null,
    ...over,
  }) as TenantSubscription;

interface BuildOpts {
  subscription?: TenantSubscription | null;
  entitlement?: { isUnlimited: boolean; limitValue: number | null } | null;
  /** Map of feature → usage count returned by `queryFeatureUsage`. */
  usage?: Partial<Record<Feature, number>>;
  entitlements?: Array<{ feature: string; isUnlimited: boolean; limitValue: number | null }>;
}

const buildSvc = (opts: BuildOpts = {}) => {
  const subRepo = {
    findByTenant: jest.fn(async () => opts.subscription ?? null),
  } as unknown as SubscriptionsRepository;

  const entitlementsRepo = {
    findByPlanAndFeature: jest.fn(async (_planId: string, feature: string) => {
      if (opts.entitlement === null) return null;
      if (opts.entitlement) {
        return {
          id: 'ent-1',
          planId: PLAN_ID,
          feature,
          isUnlimited: opts.entitlement.isUnlimited,
          limitValue: opts.entitlement.limitValue,
          description: null,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }
      return null;
    }),
    findByPlan: jest.fn(async () => opts.entitlements ?? []),
  } as unknown as PlanEntitlementsRepository;

  const db = {
    getDb: jest.fn(() => ({
      execute: jest.fn(async () => ({ rows: [{ count: 0 }] })),
    })),
  } as unknown as DbService;

  const svc = new EntitlementService(db, subRepo, entitlementsRepo);
  // Stub the usage-query dispatcher so we don't need a real DB.
  jest.spyOn(svc, 'queryFeatureUsage').mockImplementation(async (_t: string, f: Feature) => {
    return opts.usage?.[f] ?? 0;
  });
  return { svc, subRepo, entitlementsRepo };
};

describe('EntitlementService.checkEntitlement — gates', () => {
  it('rejects when no subscription exists', async () => {
    const { svc } = buildSvc({ subscription: null });
    const out = await svc.checkEntitlement(TENANT, 'monthly_scans');
    expect(out.allowed).toBe(false);
    expect(out.reason).toMatch(/no active subscription/i);
    expect(out.upgradeRequired).toBe(true);
  });

  it('rejects when subscription is expired', async () => {
    const { svc } = buildSvc({ subscription: baseSub({ status: 'expired' }) });
    const out = await svc.checkEntitlement(TENANT, 'monthly_scans');
    expect(out.allowed).toBe(false);
    expect(out.reason).toMatch(/expired/i);
  });

  it('rejects when subscription is cancelled (post-period)', async () => {
    const { svc } = buildSvc({ subscription: baseSub({ status: 'cancelled' }) });
    const out = await svc.checkEntitlement(TENANT, 'monthly_scans');
    expect(out.allowed).toBe(false);
    expect(out.reason).toMatch(/cancelled/i);
  });

  it('rejects when entitlement row missing for the feature', async () => {
    const { svc } = buildSvc({ subscription: baseSub(), entitlement: null });
    const out = await svc.checkEntitlement(TENANT, 'api_access');
    expect(out.allowed).toBe(false);
    expect(out.reason).toMatch(/not in plan/i);
    expect(out.recommendedPlan).toBe('growth');
  });

  it('rejects when entitlement exists but limit is zero', async () => {
    const { svc } = buildSvc({
      subscription: baseSub({ planCode: 'starter' }),
      entitlement: { isUnlimited: false, limitValue: 0 },
    });
    const out = await svc.checkEntitlement(TENANT, 'api_access');
    expect(out.allowed).toBe(false);
    expect(out.upgradeRequired).toBe(true);
  });
});

describe('EntitlementService.checkEntitlement — allowed paths', () => {
  it('allows unlimited features regardless of usage', async () => {
    const { svc } = buildSvc({
      subscription: baseSub({ planCode: 'pro' }),
      entitlement: { isUnlimited: true, limitValue: null },
      usage: { monthly_scans: 999_999 },
    });
    const out = await svc.checkEntitlement(TENANT, 'monthly_scans');
    expect(out.allowed).toBe(true);
    expect(out.limit).toBe('unlimited');
    expect(out.remaining).toBe('unlimited');
  });

  it('allows when current usage is below the limit', async () => {
    const { svc } = buildSvc({
      subscription: baseSub({ planCode: 'starter' }),
      entitlement: { isUnlimited: false, limitValue: 5_000 },
      usage: { monthly_scans: 1_234 },
    });
    const out = await svc.checkEntitlement(TENANT, 'monthly_scans');
    expect(out.allowed).toBe(true);
    expect(out.currentUsage).toBe(1_234);
    expect(out.remaining).toBe(3_766);
    expect(out.resetAt).toBeInstanceOf(Date);
  });

  it('rejects with PLAN_LIMIT_EXCEEDED-equivalent reason when usage hits the cap', async () => {
    const { svc } = buildSvc({
      subscription: baseSub({ planCode: 'starter' }),
      entitlement: { isUnlimited: false, limitValue: 5_000 },
      usage: { monthly_scans: 5_000 },
    });
    const out = await svc.checkEntitlement(TENANT, 'monthly_scans');
    expect(out.allowed).toBe(false);
    expect(out.upgradeRequired).toBe(true);
    expect(out.recommendedPlan).toBe('growth');
    expect(out.reason).toMatch(/limit of 5000/i);
  });
});

describe('EntitlementService.trackUsage', () => {
  it('throws PLAN_LIMIT_EXCEEDED when over the cap', async () => {
    const { svc } = buildSvc({
      subscription: baseSub({ planCode: 'starter' }),
      entitlement: { isUnlimited: false, limitValue: 100 },
      usage: { monthly_reports: 100 },
    });
    await expect(svc.trackUsage(TENANT, 'monthly_reports')).rejects.toMatchObject({
      code: ErrorCode.PLAN_LIMIT_EXCEEDED,
    });
    await expect(svc.trackUsage(TENANT, 'monthly_reports')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it('returns warningTriggered=true at >= 80% utilisation', async () => {
    const { svc } = buildSvc({
      subscription: baseSub(),
      entitlement: { isUnlimited: false, limitValue: 100 },
      usage: { monthly_reports: 79 },
    });
    const result = await svc.trackUsage(TENANT, 'monthly_reports', 1);
    expect(result.newUsage).toBe(80);
    expect(result.warningTriggered).toBe(true);
  });

  it('does not flag a warning when usage stays below 80%', async () => {
    const { svc } = buildSvc({
      subscription: baseSub(),
      entitlement: { isUnlimited: false, limitValue: 100 },
      usage: { monthly_reports: 50 },
    });
    const result = await svc.trackUsage(TENANT, 'monthly_reports', 1);
    expect(result.warningTriggered).toBe(false);
  });
});

describe('EntitlementService — property-based: usage never exceeds limit while guard is active', () => {
  it('for 50 random (limit, usage) pairs, allowed ⇔ usage < limit', async () => {
    // Lightweight property-based pass without adding a new dep.
    // For each random sample we set usage to a random value below the
    // limit and verify the guard says "allowed". Then we set usage
    // to limit and verify the guard says "not allowed". This is the
    // PBT-equivalent of "tracking usage cannot push it past the cap
    // when the guard is enforced".
    for (let i = 0; i < 50; i += 1) {
      const limit = Math.floor(Math.random() * 9_999) + 1;
      const usage = Math.floor(Math.random() * limit);
      const { svc } = buildSvc({
        subscription: baseSub(),
        entitlement: { isUnlimited: false, limitValue: limit },
        usage: { monthly_scans: usage },
      });
      const ok = await svc.checkEntitlement(TENANT, 'monthly_scans');
      expect(ok.allowed).toBe(true);
      expect(typeof ok.remaining === 'number' ? ok.remaining : 0).toBe(limit - usage);

      const { svc: svcAtLimit } = buildSvc({
        subscription: baseSub(),
        entitlement: { isUnlimited: false, limitValue: limit },
        usage: { monthly_scans: limit },
      });
      const denied = await svcAtLimit.checkEntitlement(TENANT, 'monthly_scans');
      expect(denied.allowed).toBe(false);
    }
  });
});

describe('EntitlementService.getCurrentUsage', () => {
  it('returns an empty map when there is no subscription', async () => {
    const { svc } = buildSvc({ subscription: null });
    const out = await svc.getCurrentUsage(TENANT);
    expect(out.tenantId).toBe(TENANT);
    expect(out.byFeature).toEqual({});
  });

  it('aggregates per-feature usage into the byFeature map', async () => {
    const { svc } = buildSvc({
      subscription: baseSub(),
      entitlements: [
        { feature: 'monthly_scans', isUnlimited: false, limitValue: 5_000 },
        { feature: 'monthly_reports', isUnlimited: true, limitValue: null },
      ],
      usage: { monthly_scans: 1_000, monthly_reports: 25 },
    });
    const out = await svc.getCurrentUsage(TENANT);
    expect(out.byFeature.monthly_scans).toMatchObject({ used: 1_000, limit: 5_000 });
    expect(out.byFeature.monthly_reports).toMatchObject({ used: 25, limit: 'unlimited' });
  });
});
