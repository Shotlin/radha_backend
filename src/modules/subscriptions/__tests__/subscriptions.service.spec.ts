import { DomainNotFoundException } from '@/common/errors/business.exception';

import { PlansRepository } from '../repositories/plans.repository';
import { SubscriptionEventsRepository } from '../repositories/subscription-events.repository';
import { SubscriptionsRepository } from '../repositories/subscriptions.repository';
import { EntitlementService } from '../services/entitlement.service';
import { PlanService } from '../services/plan.service';
import { TrialService } from '../services/trial.service';
import { UpgradeService } from '../services/upgrade.service';
import { SubscriptionsService } from '../subscriptions.service';
import type {
  EntitlementCheck,
  PlanFeature,
  TenantSubscription,
  UsageStats,
} from '../types/subscription.types';

const TENANT = 'tenant-1';

const baseSub = (over: Partial<TenantSubscription> = {}): TenantSubscription =>
  ({
    id: 'sub-1',
    tenantId: TENANT,
    planId: 'plan-starter',
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

const planRow = () =>
  ({
    id: 'plan-starter',
    code: 'starter',
    name: 'Starter',
    description: 'desc',
    price: '49',
    yearlyPrice: null,
    currency: 'INR',
    trialDays: 0,
    isPublic: true,
    isActive: true,
    sortOrder: 1,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  }) as never;

interface BuildOpts {
  subscription?: TenantSubscription | null;
  plan?: ReturnType<typeof planRow> | null;
  features?: PlanFeature[];
  usage?: UsageStats;
}

const buildSvc = (opts: BuildOpts = {}) => {
  const subRepo = {
    findByTenant: jest.fn(async () => opts.subscription ?? null),
  } as unknown as SubscriptionsRepository;
  const plansRepo = {
    findById: jest.fn(async () => opts.plan ?? null),
  } as unknown as PlansRepository;
  const eventsRepo = {
    create: jest.fn(async () => undefined),
  } as unknown as SubscriptionEventsRepository;

  const trial = {
    startTrial: jest.fn(async () => baseSub()),
    getDaysRemaining: jest.fn(async () => 5),
  } as unknown as TrialService;
  const upgrade = {
    upgradeOrDowngrade: jest.fn(async () => baseSub()),
    cancel: jest.fn(async () => baseSub()),
    reactivate: jest.fn(async () => baseSub()),
  } as unknown as UpgradeService;
  const entitlement = {
    checkEntitlement: jest.fn(),
    trackUsage: jest.fn(),
    getCurrentUsage: jest.fn(
      async () =>
        opts.usage ?? {
          tenantId: TENANT,
          period: { from: new Date(), to: new Date() },
          byFeature: {},
        },
    ),
  } as unknown as EntitlementService;
  const plan = {
    listPlans: jest.fn(),
    getPlan: jest.fn(),
    attachEntitlements: jest.fn(async () => ({
      ...((opts.plan ?? planRow()) as Record<string, unknown>),
      features: opts.features ?? [],
    })) as unknown as PlanService['attachEntitlements'],
  } as unknown as PlanService;

  const svc = new SubscriptionsService(
    subRepo,
    plansRepo,
    eventsRepo,
    trial,
    upgrade,
    entitlement,
    plan,
  );
  return { svc, subRepo, plansRepo, eventsRepo, trial, upgrade, entitlement, plan };
};

describe('SubscriptionsService — getStatus', () => {
  it('throws when no subscription exists', async () => {
    const { svc } = buildSvc({ subscription: null });
    await expect(svc.getStatus(TENANT)).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('throws when plan row missing', async () => {
    const { svc } = buildSvc({ subscription: baseSub(), plan: null });
    await expect(svc.getStatus(TENANT)).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('returns isActive=true and trialDaysRemaining for trial subscriptions', async () => {
    const { svc } = buildSvc({
      subscription: baseSub({ status: 'trial' }),
      plan: planRow(),
      features: [{ feature: 'monthly_scans', limit: 5_000, description: '' }],
    });
    const out = await svc.getStatus(TENANT);
    expect(out.isActive).toBe(true);
    expect(out.status).toBe('trial');
    expect(out.trialDaysRemaining).toBe(5);
    expect(out.features.monthly_scans).toBe(true);
    expect(out.limits.monthly_scans).toBe(5_000);
  });

  it('returns daysUntilRenewal for active subscriptions', async () => {
    const { svc } = buildSvc({
      subscription: baseSub({
        status: 'active',
        currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000 + 60_000),
      }),
      plan: planRow(),
      features: [],
    });
    const out = await svc.getStatus(TENANT);
    expect(out.isActive).toBe(true);
    expect(out.daysUntilRenewal).toBeGreaterThanOrEqual(7);
  });
});

describe('SubscriptionsService — recordEvent', () => {
  it('persists the event row through the repository', async () => {
    const { svc, eventsRepo } = buildSvc();
    await svc.recordEvent({
      tenantId: TENANT,
      type: 'plan_upgraded',
      oldPlanCode: 'trial',
      newPlanCode: 'starter',
      amount: 49,
      notes: 'upgrade',
    });
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      type: 'plan_upgraded',
      oldPlanCode: 'trial',
      newPlanCode: 'starter',
      amount: '49',
      notes: 'upgrade',
    });
  });
});

describe('SubscriptionsService — delegation', () => {
  it('startTrial delegates to TrialService', async () => {
    const { svc, trial } = buildSvc();
    await svc.startTrial(TENANT).catch(() => undefined);
    expect(trial.startTrial as jest.Mock).toHaveBeenCalledWith(TENANT);
  });

  it('cancel delegates to UpgradeService', async () => {
    const { svc, upgrade } = buildSvc();
    await svc.cancel(TENANT, 'reason', 'user').catch(() => undefined);
    expect(upgrade.cancel as jest.Mock).toHaveBeenCalledWith(TENANT, 'reason', 'user');
  });

  it('reactivate delegates to UpgradeService', async () => {
    const { svc, upgrade } = buildSvc();
    await svc.reactivate(TENANT, 'user').catch(() => undefined);
    expect(upgrade.reactivate as jest.Mock).toHaveBeenCalledWith(TENANT, 'user');
  });

  it('checkEntitlement delegates to EntitlementService', async () => {
    const expected: EntitlementCheck = {
      allowed: true,
      feature: 'monthly_scans',
      currentUsage: 0,
      limit: 0,
      remaining: 0,
    };
    const { svc, entitlement } = buildSvc();
    (entitlement.checkEntitlement as jest.Mock).mockResolvedValueOnce(expected);
    const out = await svc.checkEntitlement(TENANT, 'monthly_scans');
    expect(out).toEqual(expected);
  });
});
