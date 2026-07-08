import {
  BusinessException,
  DomainConflictException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { PlansRepository } from '../repositories/plans.repository';
import { SubscriptionEventsRepository } from '../repositories/subscription-events.repository';
import { SubscriptionsRepository } from '../repositories/subscriptions.repository';
import { UpgradeService } from '../services/upgrade.service';
import type { TenantSubscription } from '../types/subscription.types';

const TENANT = '00000000-0000-0000-0000-000000000aaa';
const SUB_ID = 'sub-1';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const baseSub = (over: Partial<TenantSubscription> = {}): TenantSubscription =>
  ({
    id: SUB_ID,
    tenantId: TENANT,
    planId: 'plan-trial',
    planCode: 'trial',
    status: 'trial',
    trialStartedAt: new Date(),
    trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    cancelledAt: null,
    cancellationReason: null,
    monthlyAmount: '0',
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

const planRow = (code: string, id: string, price = '49') =>
  ({
    id,
    code,
    name: code,
    description: null,
    price,
    yearlyPrice: null,
    currency: 'INR',
    trialDays: 0,
    isPublic: true,
    isActive: true,
    sortOrder: 0,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  }) as never;

interface BuildOpts {
  subscription?: TenantSubscription | null;
  targetPlan?: ReturnType<typeof planRow> | null;
  guardReturnsNull?: boolean;
  dueRenewals?: TenantSubscription[];
  endOfCycleCancellations?: TenantSubscription[];
}

const buildSvc = (opts: BuildOpts = {}) => {
  const subRepo = {
    findByTenant: jest.fn(async () => opts.subscription ?? null),
    updateStatusGuarded: jest.fn(
      async (id: string, _from: unknown, patch: Partial<TenantSubscription>) =>
        opts.guardReturnsNull ? null : baseSub({ ...(opts.subscription ?? {}), ...patch, id }),
    ),
    findRenewalsDue: jest.fn(async () => opts.dueRenewals ?? []),
    findEndOfCycleCancellations: jest.fn(async () => opts.endOfCycleCancellations ?? []),
  } as unknown as SubscriptionsRepository;

  const plansRepo = {
    findByCode: jest.fn(async (_code: string) => opts.targetPlan ?? null),
  } as unknown as PlansRepository;

  const eventsRepo = {
    create: jest.fn(async () => undefined),
  } as unknown as SubscriptionEventsRepository;

  const auditLog = {
    logAction: jest.fn(async () => undefined),
  } as unknown as AuditLogService;

  const svc = new UpgradeService(subRepo, plansRepo, eventsRepo, auditLog, buildLogger());
  return { svc, subRepo, plansRepo, eventsRepo, auditLog };
};

describe('UpgradeService.upgradeOrDowngrade', () => {
  it('rejects when there is no subscription', async () => {
    const { svc } = buildSvc({ subscription: null });
    await expect(svc.upgradeOrDowngrade(TENANT, 'starter', 'user')).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('rejects upgrades on expired subscriptions with SUBSCRIPTION_REQUIRED', async () => {
    const { svc } = buildSvc({ subscription: baseSub({ status: 'expired' }) });
    await expect(svc.upgradeOrDowngrade(TENANT, 'starter', 'user')).rejects.toMatchObject({
      code: ErrorCode.SUBSCRIPTION_REQUIRED,
    });
  });

  it('returns the same subscription for a same-plan no-op', async () => {
    const sub = baseSub({ planCode: 'starter', status: 'active' });
    const { svc, subRepo } = buildSvc({ subscription: sub });
    const out = await svc.upgradeOrDowngrade(TENANT, 'starter', 'user');
    expect(out).toEqual(sub);
    expect(subRepo.updateStatusGuarded as jest.Mock).not.toHaveBeenCalled();
  });

  it('throws when target plan is not seeded', async () => {
    const { svc } = buildSvc({
      subscription: baseSub({ planCode: 'starter', status: 'active' }),
      targetPlan: null,
    });
    await expect(svc.upgradeOrDowngrade(TENANT, 'growth', 'user')).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('applies an upgrade immediately, sets status=active, emits plan_upgraded event', async () => {
    const { svc, subRepo, eventsRepo, auditLog } = buildSvc({
      subscription: baseSub({ planCode: 'trial' }),
      targetPlan: planRow('starter', 'plan-starter', '49'),
    });
    const out = await svc.upgradeOrDowngrade(TENANT, 'starter', 'user-1');
    expect(out.planCode).toBe('starter');
    expect(out.status).toBe('active');
    const guardCall = (subRepo.updateStatusGuarded as jest.Mock).mock.calls[0];
    expect(guardCall[2].planId).toBe('plan-starter');
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('plan_upgraded');
    expect((auditLog.logAction as jest.Mock).mock.calls[0][0].metadata.transition).toBe(
      'plan_upgraded',
    );
  });

  it('schedules a downgrade for end-of-cycle (pending fields stamped)', async () => {
    const sub = baseSub({ planCode: 'pro', status: 'active' });
    const { svc, subRepo, eventsRepo } = buildSvc({
      subscription: sub,
      targetPlan: planRow('growth', 'plan-growth', '99'),
    });
    await svc.upgradeOrDowngrade(TENANT, 'growth', 'user-1');
    const guardCall = (subRepo.updateStatusGuarded as jest.Mock).mock.calls[0];
    expect(guardCall[2].pendingPlanId).toBe('plan-growth');
    expect(guardCall[2].pendingPlanCode).toBe('growth');
    expect(guardCall[2].planCode).toBeUndefined();
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('plan_downgrade_scheduled');
  });

  it('surfaces a clean error when the optimistic guard rejects (concurrent change)', async () => {
    const { svc } = buildSvc({
      subscription: baseSub({ planCode: 'trial' }),
      targetPlan: planRow('starter', 'plan-starter'),
      guardReturnsNull: true,
    });
    await expect(svc.upgradeOrDowngrade(TENANT, 'starter', 'user-1')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });
});

describe('UpgradeService.cancel', () => {
  it('rejects cancelling an already-cancelled subscription', async () => {
    const { svc } = buildSvc({ subscription: baseSub({ status: 'cancelled' }) });
    await expect(svc.cancel(TENANT, 'why', 'user')).rejects.toBeInstanceOf(DomainConflictException);
  });

  it('rejects cancelling an expired subscription', async () => {
    const { svc } = buildSvc({ subscription: baseSub({ status: 'expired' }) });
    await expect(svc.cancel(TENANT, 'why', 'user')).rejects.toBeInstanceOf(BusinessException);
  });

  it('cancels a trial / active subscription, emits cancelled event with reason + audit log', async () => {
    const { svc, subRepo, eventsRepo, auditLog } = buildSvc({
      subscription: baseSub({ status: 'active', planCode: 'starter' }),
    });
    await svc.cancel(TENANT, 'too expensive', 'user-1');
    const guardCall = (subRepo.updateStatusGuarded as jest.Mock).mock.calls[0];
    expect(guardCall[2].status).toBe('cancelled');
    expect(guardCall[2].cancellationReason).toBe('too expensive');
    const evt = (eventsRepo.create as jest.Mock).mock.calls[0][0];
    expect(evt.type).toBe('subscription_cancelled');
    expect(evt.notes).toBe('too expensive');
    expect((auditLog.logAction as jest.Mock).mock.calls[0][0]).toMatchObject({
      action: 'UPDATE',
      metadata: { transition: 'cancel', reason: 'too expensive' },
    });
  });
});

describe('UpgradeService.reactivate', () => {
  it('rejects when subscription is not cancelled', async () => {
    const { svc } = buildSvc({ subscription: baseSub({ status: 'active' }) });
    await expect(svc.reactivate(TENANT, 'user')).rejects.toBeInstanceOf(BusinessException);
  });

  it('rejects when the cancelled period has already elapsed', async () => {
    const { svc } = buildSvc({
      subscription: baseSub({
        status: 'cancelled',
        currentPeriodEnd: new Date(Date.now() - 1_000),
      }),
    });
    await expect(svc.reactivate(TENANT, 'user')).rejects.toBeInstanceOf(BusinessException);
  });

  it('reactivates a cancelled subscription and clears cancel stamps', async () => {
    const { svc, subRepo, eventsRepo, auditLog } = buildSvc({
      subscription: baseSub({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancellationReason: 'why',
      }),
    });
    const out = await svc.reactivate(TENANT, 'user-1');
    expect(out.status).toBe('active');
    const guardCall = (subRepo.updateStatusGuarded as jest.Mock).mock.calls[0];
    expect(guardCall[2].cancelledAt).toBeNull();
    expect(guardCall[2].cancellationReason).toBeNull();
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('subscription_reactivated');
    expect((auditLog.logAction as jest.Mock).mock.calls[0][0].metadata.transition).toBe(
      'reactivate',
    );
  });
});

describe('UpgradeService.runRenewalsForDate', () => {
  it('renews active subs with no pending plan and bumps the period forward', async () => {
    const sub = baseSub({ status: 'active', planCode: 'starter', planId: 'plan-starter' });
    const { svc, eventsRepo } = buildSvc({ dueRenewals: [sub] });
    const result = await svc.runRenewalsForDate();
    expect(result.renewed).toBe(1);
    expect(result.applied).toBe(0);
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('subscription_renewed');
  });

  it('applies a pending downgrade at the cycle boundary', async () => {
    const sub = baseSub({
      status: 'active',
      planCode: 'pro',
      planId: 'plan-pro',
      pendingPlanId: 'plan-growth',
      pendingPlanCode: 'growth',
    });
    const { svc, subRepo, eventsRepo } = buildSvc({ dueRenewals: [sub] });
    const result = await svc.runRenewalsForDate();
    expect(result.applied).toBe(1);
    const guardCall = (subRepo.updateStatusGuarded as jest.Mock).mock.calls[0];
    expect(guardCall[2].planId).toBe('plan-growth');
    expect(guardCall[2].pendingPlanId).toBeNull();
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('plan_downgraded');
  });

  it('expires cancelled subscriptions whose period has elapsed', async () => {
    const sub = baseSub({ status: 'cancelled', planCode: 'starter' });
    const { svc, eventsRepo } = buildSvc({ endOfCycleCancellations: [sub] });
    const result = await svc.runRenewalsForDate();
    expect(result.expired).toBe(1);
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('trial_expired');
  });
});
