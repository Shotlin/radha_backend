import { DomainNotFoundException } from '@/common/errors/business.exception';

import { PlanEntitlementsRepository } from '../repositories/plan-entitlements.repository';
import { PlansRepository } from '../repositories/plans.repository';
import { PlanService } from '../services/plan.service';

const PLAN_ID = '00000000-0000-0000-0000-000000000aaa';

const fakePlanRow = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: PLAN_ID,
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
    ...over,
  }) as never;

const buildSvc = (opts: {
  active?: ReturnType<typeof fakePlanRow>[];
  byCode?: ReturnType<typeof fakePlanRow> | null;
  byId?: ReturnType<typeof fakePlanRow> | null;
  entitlements?: Array<{
    feature: string;
    isUnlimited: boolean;
    limitValue: number | null;
    description: string;
  }>;
}) => {
  const plansRepo = {
    listActive: jest.fn(async () => opts.active ?? []),
    findByCode: jest.fn(async () => opts.byCode ?? null),
    findById: jest.fn(async () => opts.byId ?? null),
  } as unknown as PlansRepository;

  const entitlementsRepo = {
    findByPlan: jest.fn(async () =>
      (opts.entitlements ?? []).map((e, i) => ({
        id: `ent-${i}`,
        planId: PLAN_ID,
        feature: e.feature,
        isUnlimited: e.isUnlimited,
        limitValue: e.limitValue,
        description: e.description,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    ),
  } as unknown as PlanEntitlementsRepository;

  return { svc: new PlanService(plansRepo, entitlementsRepo), plansRepo, entitlementsRepo };
};

describe('PlanService', () => {
  it('listPlans composes plan rows with their entitlement features', async () => {
    const { svc } = buildSvc({
      active: [fakePlanRow({ code: 'pro' })],
      entitlements: [
        {
          feature: 'monthly_scans',
          isUnlimited: true,
          limitValue: null,
          description: 'unlimited',
        },
        {
          feature: 'monthly_reports',
          isUnlimited: false,
          limitValue: 200,
          description: '200 reports',
        },
      ],
    });
    const out = await svc.listPlans();
    expect(out).toHaveLength(1);
    expect(out[0].features).toEqual([
      expect.objectContaining({ feature: 'monthly_scans', limit: 'unlimited' }),
      expect.objectContaining({ feature: 'monthly_reports', limit: 200 }),
    ]);
  });

  it('getPlan throws DomainNotFoundException for missing code', async () => {
    const { svc } = buildSvc({ byCode: null });
    await expect(svc.getPlan('starter')).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('getPlan returns plan with entitlement features', async () => {
    const { svc } = buildSvc({
      byCode: fakePlanRow({ code: 'starter' }),
      entitlements: [
        {
          feature: 'monthly_scans',
          isUnlimited: false,
          limitValue: 10_000,
          description: '10k',
        },
      ],
    });
    const out = await svc.getPlan('starter');
    expect(out.code).toBe('starter');
    expect(out.features[0].limit).toBe(10_000);
  });

  it('getPlanById throws when missing', async () => {
    const { svc } = buildSvc({ byId: null });
    await expect(svc.getPlanById(PLAN_ID)).rejects.toBeInstanceOf(DomainNotFoundException);
  });
});
